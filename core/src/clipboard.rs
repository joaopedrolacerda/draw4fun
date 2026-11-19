//! Copiar e colar elementos, inclusive entre abas e entre desenhos.
//!
//! O que vai para a área de transferência é um JSON com os elementos copiados e os
//! arquivos de imagem que eles usam, marcado com `"type": "draw4fun/clipboard"` para o
//! colar saber que veio daqui (e não é um texto qualquer). Cópias feitas quando o app se
//! chamava Rabisco (`"rabisco/clipboard"`) continuam sendo aceitas.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::board::Board;
use crate::error::CoreError;
use crate::geometry::{self, Bounds};
use crate::model::{Element, ImageFile, SCHEMA_VERSION, Shape};

pub const CLIPBOARD_KIND: &str = "draw4fun/clipboard";
/// Marca das cópias feitas quando o app se chamava Rabisco.
const LEGACY_CLIPBOARD_KIND: &str = "rabisco/clipboard";

fn known_kind(kind: &str) -> bool {
    kind == CLIPBOARD_KIND || kind == LEGACY_CLIPBOARD_KIND
}

fn mentions_kind(text: &str) -> bool {
    text.contains(CLIPBOARD_KIND) || text.contains(LEGACY_CLIPBOARD_KIND)
}

/// Deslocamento de quem é colado sem um ponto de destino (ou duplicado), para a cópia
/// não ficar exatamente em cima do original.
pub const PASTE_OFFSET: f64 = 16.0;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Clipboard {
    #[serde(rename = "type")]
    kind: String,
    schema_version: u32,
    elements: Vec<Element>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    files: BTreeMap<String, ImageFile>,
}

/// Diz se o texto é um conteúdo copiado do draw4fun.
pub fn is_clipboard(text: &str) -> bool {
    // Atalho barato antes de tentar ler o JSON inteiro de um texto qualquer.
    mentions_kind(text)
        && serde_json::from_str::<Clipboard>(text).is_ok_and(|c| known_kind(&c.kind))
}

fn union(elements: &[Element]) -> Option<Bounds> {
    elements
        .iter()
        .filter_map(geometry::bounds)
        .reduce(|a, b| Bounds {
            min_x: a.min_x.min(b.min_x),
            min_y: a.min_y.min(b.min_y),
            max_x: a.max_x.max(b.max_x),
            max_y: a.max_y.max(b.max_y),
        })
}

impl Board {
    /// Copia os elementos visíveis com esses ids, na ordem de desenho, com as imagens que usam.
    pub fn copy(&self, ids: &[String]) -> Result<String, CoreError> {
        let elements: Vec<Element> = self
            .doc
            .visible()
            .filter(|e| ids.contains(&e.id))
            .cloned()
            .collect();
        if elements.is_empty() {
            return Err(CoreError::NotFound(ids.join(", ")));
        }
        let files = elements
            .iter()
            .filter_map(|e| match &e.shape {
                Shape::Image { file_id, .. } => self
                    .doc
                    .files
                    .get(file_id)
                    .map(|f| (file_id.clone(), f.clone())),
                _ => None,
            })
            .collect();
        let clip = Clipboard {
            kind: CLIPBOARD_KIND.into(),
            schema_version: SCHEMA_VERSION,
            elements,
            files,
        };
        Ok(serde_json::to_string(&clip)?)
    }

    /// Cola elementos copiados. Com `at`, o grupo fica centrado nesse ponto; sem, fica
    /// [`PASTE_OFFSET`] para baixo e para a direita do original. Cada cópia ganha id novo e
    /// começa na versão 1, mas mantém a semente: o rabisco sai igual ao do original.
    /// Devolve os ids novos, na ordem de desenho.
    pub fn paste(&mut self, json: &str, at: Option<(f64, f64)>) -> Result<Vec<String>, CoreError> {
        if !mentions_kind(json) {
            return Err(CoreError::NotClipboard);
        }
        let clip: Clipboard = serde_json::from_str(json)?;
        if !known_kind(&clip.kind) {
            return Err(CoreError::NotClipboard);
        }
        if clip.schema_version > SCHEMA_VERSION {
            return Err(CoreError::UnsupportedSchema(clip.schema_version));
        }
        let (dx, dy) = match (at, union(&clip.elements)) {
            (Some((x, y)), Some(b)) => {
                (x - (b.min_x + b.max_x) / 2.0, y - (b.min_y + b.max_y) / 2.0)
            }
            _ => (PASTE_OFFSET, PASTE_OFFSET),
        };
        for (k, v) in clip.files {
            self.doc.files.entry(k).or_insert(v);
        }
        let mut ids = Vec::with_capacity(clip.elements.len());
        for mut el in clip.elements {
            el.id = self.new_id();
            el.version = 1;
            el.nonce = self.rng.next_u32();
            el.deleted = false;
            el.shape.translate(dx, dy);
            ids.push(el.id.clone());
            self.record_new(&el.id);
            self.doc.elements.push(el);
        }
        Ok(ids)
    }

    /// Duplica os elementos ao lado dos originais (copiar e colar de uma vez).
    pub fn duplicate(&mut self, ids: &[String]) -> Result<Vec<String>, CoreError> {
        let json = self.copy(ids)?;
        self.paste(&json, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Point, Style};

    fn bounds(board: &Board, id: &str) -> Option<(f64, f64, f64, f64)> {
        board
            .bounds(id)
            .map(|b| (b.min_x, b.min_y, b.max_x, b.max_y))
    }

    #[test]
    fn copiar_e_colar_cria_copia_deslocada_com_id_novo() {
        let mut board = Board::new(1);
        let r = board.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        let json = board.copy(std::slice::from_ref(&r)).expect("copia");
        assert!(is_clipboard(&json));
        let pasted = board.paste(&json, None).expect("cola");
        assert_eq!(pasted.len(), 1);
        let copy = &pasted[0];
        assert_ne!(copy, &r);
        assert_eq!(bounds(&board, copy), Some((16.0, 16.0, 26.0, 26.0)));
        let (orig, dup) = (
            board.get(&r).expect("existe"),
            board.get(copy).expect("existe"),
        );
        assert_eq!(dup.version, 1);
        assert_eq!(dup.seed, orig.seed);
        assert_eq!(board.visible_ids(), vec![r.clone(), copy.clone()]);
    }

    #[test]
    fn colar_num_ponto_centra_o_grupo_ali() {
        let mut board = Board::new(1);
        let a = board.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        let b = board.add_rectangle(20.0, 0.0, 10.0, 10.0, Style::default());
        let json = board.copy(&[a, b]).expect("copia");
        let pasted = board.paste(&json, Some((100.0, 100.0))).expect("cola");
        assert_eq!(bounds(&board, &pasted[0]), Some((85.0, 95.0, 95.0, 105.0)));
        assert_eq!(
            bounds(&board, &pasted[1]),
            Some((105.0, 95.0, 115.0, 105.0))
        );
    }

    #[test]
    fn copia_leva_a_imagem_junto_e_cola_em_outro_desenho() {
        let mut origin = Board::new(1);
        let i = origin.add_image(0.0, 0.0, 10.0, 10.0, "f1", "image/png", "data:a");
        let json = origin.copy(&[i]).expect("copia");
        let mut other = Board::new(2);
        let pasted = other.paste(&json, None).expect("cola");
        assert_eq!(
            other.file("f1").map(|f| f.data_url.as_str()),
            Some("data:a")
        );
        assert_eq!(other.get(&pasted[0]).map(|e| e.shape.kind()), Some("image"));
    }

    #[test]
    fn copia_ignora_apagados_e_mantem_a_ordem_de_desenho() {
        let mut board = Board::new(1);
        let a = board.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        let f = board.add_freehand(Point::new(0.0, 0.0), Style::default());
        let gone = board.add_rectangle(0.0, 0.0, 1.0, 1.0, Style::default());
        board.delete(&gone).expect("existe");
        let json = board
            .copy(&[f.clone(), gone.clone(), a.clone()])
            .expect("copia");
        let pasted = board.paste(&json, None).expect("cola");
        let kinds: Vec<_> = pasted
            .iter()
            .filter_map(|id| board.get(id).map(|e| e.shape.kind()))
            .collect();
        assert_eq!(kinds, vec!["rectangle", "freehand"]);
    }

    #[test]
    fn copiar_nada_da_erro() {
        let board = Board::new(1);
        assert!(matches!(
            board.copy(&["x".into()]),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn texto_qualquer_nao_e_conteudo_do_draw4fun() {
        let mut board = Board::new(1);
        assert!(!is_clipboard("olá"));
        assert!(!is_clipboard(r#"{"type":"outra/coisa","elements":[]}"#));
        assert!(matches!(
            board.paste("olá", None),
            Err(CoreError::NotClipboard)
        ));
        assert!(matches!(
            board.paste(r#"{"type":"draw4fun/clipboard"#, None),
            Err(CoreError::Json(_))
        ));
    }

    #[test]
    fn recusa_conteudo_de_versao_futura() {
        let mut board = Board::new(1);
        let json = r#"{"type":"draw4fun/clipboard","schemaVersion":99,"elements":[]}"#;
        assert!(matches!(
            board.paste(json, None),
            Err(CoreError::UnsupportedSchema(99))
        ));
    }

    #[test]
    fn aceita_copia_feita_quando_o_app_se_chamava_rabisco() {
        let mut source = Board::new(1);
        let t = source.add_text(0.0, 0.0, "oi", 20.0, 30.0, 25.0, Style::default());
        let legacy = source
            .copy(&[t])
            .expect("copia")
            .replace(CLIPBOARD_KIND, LEGACY_CLIPBOARD_KIND);
        assert!(legacy.contains("\"rabisco/clipboard\""));
        assert!(is_clipboard(&legacy));
        let mut target = Board::new(2);
        assert_eq!(target.paste(&legacy, None).expect("cola").len(), 1);
    }

    #[test]
    fn duplicar_poe_ao_lado() {
        let mut board = Board::new(1);
        let t = board.add_text(0.0, 0.0, "oi", 20.0, 30.0, 25.0, Style::default());
        let dup = board.duplicate(&[t]).expect("duplica");
        assert_eq!(bounds(&board, &dup[0]), Some((16.0, 16.0, 46.0, 41.0)));
    }
}
