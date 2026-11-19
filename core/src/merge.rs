//! Merge de duas cópias do mesmo desenho (por exemplo, a local e a do Drive).
//!
//! A regra é por elemento: a cópia com a `version` maior vence; empatou, vence o `nonce`
//! maior. Apagar é só mais uma mudança (o elemento fica com `deleted: true`), então
//! apagar e editar disputam pela mesma regra. Assim o merge é comutativo: os dois
//! aparelhos chegam ao mesmo resultado, não importa quem sincroniza primeiro.

use std::collections::HashMap;

use crate::model::{Document, Element, SCHEMA_VERSION};

fn wins(candidate: &Element, current: &Element) -> bool {
    (candidate.version, candidate.nonce) > (current.version, current.nonce)
}

/// Junta `local` e `remote`. A ordem de desenho segue a cópia local; elementos que só
/// existem na remota entram depois do vizinho que vinha antes deles lá (ou no fim).
pub fn merge(local: &Document, remote: &Document) -> Document {
    let remote_by_id: HashMap<&str, &Element> =
        remote.elements.iter().map(|e| (e.id.as_str(), e)).collect();
    let local_ids: HashMap<&str, ()> = local.elements.iter().map(|e| (e.id.as_str(), ())).collect();

    let mut elements: Vec<Element> = local
        .elements
        .iter()
        .map(|l| match remote_by_id.get(l.id.as_str()) {
            Some(r) if wins(r, l) => (*r).clone(),
            _ => l.clone(),
        })
        .collect();

    let mut anchor: Option<&str> = None;
    for r in &remote.elements {
        if local_ids.contains_key(r.id.as_str()) {
            anchor = Some(r.id.as_str());
            continue;
        }
        let at = anchor
            .and_then(|a| elements.iter().position(|e| e.id == a))
            .map_or(elements.len(), |i| i + 1);
        elements.insert(at, r.clone());
        anchor = Some(r.id.as_str());
    }

    // Arquivos de imagem são imutáveis (a chave vem do conteúdo): basta juntar.
    let mut files = local.files.clone();
    for (k, v) in &remote.files {
        files.entry(k.clone()).or_insert_with(|| v.clone());
    }

    // Fundo: mesma regra dos elementos (versão maior; empatou, nonce maior).
    let background = match (&local.background, &remote.background) {
        (Some(l), Some(r)) => Some(
            if (r.version, r.nonce) > (l.version, l.nonce) {
                r
            } else {
                l
            }
            .clone(),
        ),
        (l, r) => l.clone().or_else(|| r.clone()),
    };

    Document {
        schema_version: SCHEMA_VERSION.max(local.schema_version),
        elements,
        files,
        background,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Shape, Style};

    fn el(id: &str, version: u32, nonce: u32, x: f64) -> Element {
        Element {
            id: id.into(),
            version,
            nonce,
            seed: 1,
            deleted: false,
            style: Style::default(),
            shape: Shape::Rectangle {
                x,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
        }
    }

    fn doc(elements: Vec<Element>) -> Document {
        Document {
            schema_version: SCHEMA_VERSION,
            elements,
            files: Default::default(),
            background: None,
        }
    }

    fn ids(d: &Document) -> Vec<&str> {
        d.elements.iter().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn elementos_diferentes_se_juntam() {
        let local = doc(vec![el("a", 1, 0, 0.0)]);
        let remote = doc(vec![el("b", 1, 0, 0.0)]);
        assert_eq!(ids(&merge(&local, &remote)), vec!["a", "b"]);
    }

    #[test]
    fn versao_maior_vence() {
        let local = doc(vec![el("a", 2, 0, 1.0)]);
        let remote = doc(vec![el("a", 5, 0, 2.0)]);
        assert_eq!(merge(&local, &remote).elements[0].version, 5);
        assert_eq!(merge(&remote, &local).elements[0].version, 5);
    }

    #[test]
    fn empate_de_versao_decide_pelo_nonce() {
        let local = doc(vec![el("a", 3, 10, 1.0)]);
        let remote = doc(vec![el("a", 3, 20, 2.0)]);
        assert_eq!(merge(&local, &remote).elements[0].nonce, 20);
        assert_eq!(merge(&remote, &local).elements[0].nonce, 20);
    }

    #[test]
    fn apagado_com_versao_maior_continua_apagado() {
        let mut deleted = el("a", 4, 0, 0.0);
        deleted.deleted = true;
        let local = doc(vec![el("a", 3, 0, 0.0)]);
        let remote = doc(vec![deleted]);
        assert!(merge(&local, &remote).elements[0].deleted);
    }

    #[test]
    fn edicao_posterior_ressuscita_elemento_apagado() {
        let mut deleted = el("a", 2, 0, 0.0);
        deleted.deleted = true;
        let local = doc(vec![deleted]);
        let remote = doc(vec![el("a", 3, 0, 9.0)]);
        assert!(!merge(&local, &remote).elements[0].deleted);
    }

    #[test]
    fn novo_elemento_remoto_entra_depois_do_vizinho() {
        let local = doc(vec![el("a", 1, 0, 0.0), el("c", 1, 0, 0.0)]);
        let remote = doc(vec![
            el("a", 1, 0, 0.0),
            el("b", 1, 0, 0.0),
            el("c", 1, 0, 0.0),
        ]);
        assert_eq!(ids(&merge(&local, &remote)), vec!["a", "b", "c"]);
    }

    #[test]
    fn merge_e_comutativo_no_conteudo() {
        let local = doc(vec![el("a", 2, 1, 1.0), el("b", 1, 0, 0.0)]);
        let remote = doc(vec![el("a", 2, 7, 3.0), el("c", 4, 0, 0.0)]);
        let mut x = merge(&local, &remote).elements;
        let mut y = merge(&remote, &local).elements;
        x.sort_by(|p, q| p.id.cmp(&q.id));
        y.sort_by(|p, q| p.id.cmp(&q.id));
        assert_eq!(x, y);
    }

    #[test]
    fn arquivos_de_imagem_dos_dois_lados_se_juntam() {
        use crate::model::ImageFile;
        let file = |u: &str| ImageFile {
            mime_type: "image/png".into(),
            data_url: u.into(),
        };
        let mut local = doc(vec![]);
        local.files.insert("a".into(), file("data:a"));
        let mut remote = doc(vec![]);
        remote.files.insert("b".into(), file("data:b"));
        let merged = merge(&local, &remote);
        assert_eq!(merged.files.keys().collect::<Vec<_>>(), vec!["a", "b"]);
    }

    #[test]
    fn merge_consigo_mesmo_nao_muda_nada() {
        let d = doc(vec![el("a", 1, 0, 0.0), el("b", 2, 3, 4.0)]);
        assert_eq!(merge(&d, &d), d);
    }

    #[test]
    fn fundo_mais_novo_vence_dos_dois_lados() {
        use crate::model::Background;
        let bg = |color: &str, version, nonce| {
            Some(Background {
                color: color.into(),
                version,
                nonce,
            })
        };
        let mut local = doc(vec![]);
        local.background = bg("#000", 2, 5);
        let mut remote = doc(vec![]);
        remote.background = bg("#ff0", 3, 1);
        assert_eq!(merge(&local, &remote).background, bg("#ff0", 3, 1));
        assert_eq!(merge(&remote, &local).background, bg("#ff0", 3, 1));
        remote.background = bg("#ff0", 2, 9);
        assert_eq!(merge(&local, &remote).background, bg("#ff0", 2, 9));
        assert_eq!(merge(&remote, &local).background, bg("#ff0", 2, 9));
        remote.background = None;
        assert_eq!(merge(&remote, &local).background, bg("#000", 2, 5));
    }
}
