//! Sessão de edição de um desenho: o documento mais o gerador de ids e sementes.

use crate::error::CoreError;
use crate::geometry;
use crate::history::History;
use crate::merge::merge;
use crate::model::{Document, Element, ImageFile, Point, Shape, Style};
use crate::render::{RenderPath, render};
use crate::rng::Rng;

/// Distância mínima entre dois pontos seguidos de um traço livre. Pontos mais
/// próximos que isso não acrescentam nada e deixam o contorno serrilhado.
const MIN_POINT_DISTANCE: f64 = 0.5;

/// Menor largura ou altura que um redimensionamento deixa (unidades do mundo).
pub const MIN_SIZE: f64 = 1.0;
/// Menor tamanho de fonte que um redimensionamento deixa.
pub const MIN_FONT_SIZE: f64 = 4.0;

#[derive(Debug, Clone)]
pub struct Board {
    pub(crate) doc: Document,
    pub(crate) rng: Rng,
    pub(crate) history: History,
}

impl Board {
    /// `seed` deve vir de uma fonte aleatória de verdade (por exemplo, `crypto` no navegador):
    /// é dela que saem os ids, e dois aparelhos não podem gerar o mesmo id.
    pub fn new(seed: u64) -> Self {
        Board {
            doc: Document::default(),
            rng: Rng::new(seed),
            history: History::default(),
        }
    }

    pub fn from_document(doc: Document, seed: u64) -> Self {
        Board {
            doc,
            rng: Rng::new(seed),
            history: History::default(),
        }
    }

    pub fn from_json(json: &str, seed: u64) -> Result<Self, CoreError> {
        Ok(Board::from_document(Document::from_json(json)?, seed))
    }

    pub fn to_json(&self) -> Result<String, CoreError> {
        self.doc.to_json()
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    pub fn get(&self, id: &str) -> Option<&Element> {
        self.doc.get(id)
    }

    /// Cor de fundo escolhida, ou `None` para o fundo padrão.
    pub fn background(&self) -> Option<&str> {
        self.doc.background.as_ref().map(|b| b.color.as_str())
    }

    /// Troca a cor de fundo. Não entra no desfazer: é uma preferência do quadro, não um
    /// traço. Devolve `false` se a cor já era essa.
    pub fn set_background(&mut self, color: &str) -> bool {
        if self.background() == Some(color) {
            return false;
        }
        let version = self.doc.background.as_ref().map_or(0, |b| b.version) + 1;
        let nonce = self.rng.next_u32();
        self.doc.background = Some(crate::model::Background {
            color: color.to_string(),
            version,
            nonce,
        });
        true
    }

    /// Ids dos elementos visíveis, do fundo para a frente.
    pub fn visible_ids(&self) -> Vec<String> {
        self.doc.visible().map(|e| e.id.clone()).collect()
    }

    pub fn add_rectangle(
        &mut self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        style: Style,
    ) -> String {
        let (x, y, width, height) = normalize(x, y, width, height);
        self.insert(
            style,
            Shape::Rectangle {
                x,
                y,
                width,
                height,
            },
        )
    }

    /// Muda posição e tamanho. Largura e altura negativas são normalizadas, então dá para
    /// passar direto "ponto inicial" e "ponto atual menos o inicial" enquanto se arrasta.
    pub fn set_rectangle(
        &mut self,
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), CoreError> {
        self.set_frame(id, x, y, width, height)
    }

    /// Como [`Board::set_rectangle`], para qualquer forma que é uma caixa: retângulo ou boneco.
    pub fn set_frame(
        &mut self,
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), CoreError> {
        let (nx, ny, nw, nh) = normalize(x, y, width, height);
        self.record(id);
        let el = self.element_mut(id)?;
        match &mut el.shape {
            Shape::Rectangle {
                x,
                y,
                width,
                height,
            }
            | Shape::Figure {
                x,
                y,
                width,
                height,
            } => {
                (*x, *y, *width, *height) = (nx, ny, nw, nh);
            }
            _ => return Err(CoreError::WrongKind(id.into())),
        }
        self.touch(id)
    }

    /// Seta passando pelos pontos, com a ponta no último (pelo menos dois pontos;
    /// com menos, o começo vira a ponta também).
    pub fn add_arrow(&mut self, mut points: Vec<[f64; 2]>, style: Style) -> String {
        while points.len() < 2 {
            points.push(points.last().copied().unwrap_or([0.0, 0.0]));
        }
        self.insert(style, Shape::Arrow { points })
    }

    /// Move a ponta da seta (o começo fica onde está).
    pub fn set_arrow_end(&mut self, id: &str, nx: f64, ny: f64) -> Result<(), CoreError> {
        self.record(id);
        let el = self.element_mut(id)?;
        let Shape::Arrow { points } = &mut el.shape else {
            return Err(CoreError::WrongKind(id.into()));
        };
        if let Some(last) = points.last_mut() {
            *last = [nx, ny];
        }
        self.touch(id)
    }

    /// Boneco de palitinho ocupando a caixa.
    pub fn add_figure(&mut self, x: f64, y: f64, width: f64, height: f64, style: Style) -> String {
        let (x, y, width, height) = normalize(x, y, width, height);
        self.insert(
            style,
            Shape::Figure {
                x,
                y,
                width,
                height,
            },
        )
    }

    pub fn add_freehand(&mut self, first: Point, style: Style) -> String {
        self.insert(
            style,
            Shape::Freehand {
                points: vec![first],
            },
        )
    }

    /// Acrescenta um ponto ao traço. Devolve `false` se o ponto foi ignorado por estar
    /// colado no anterior.
    pub fn push_point(&mut self, id: &str, point: Point) -> Result<bool, CoreError> {
        self.record(id);
        let el = self.element_mut(id)?;
        let Shape::Freehand { points } = &mut el.shape else {
            return Err(CoreError::WrongKind(id.into()));
        };
        if let Some(last) = points.last()
            && (last.x - point.x).hypot(last.y - point.y) < MIN_POINT_DISTANCE
        {
            return Ok(false);
        }
        points.push(point);
        self.touch(id)?;
        Ok(true)
    }

    /// Cria um texto. `width` e `height` são a medida feita pela plataforma com a fonte dela.
    #[allow(clippy::too_many_arguments)]
    pub fn add_text(
        &mut self,
        x: f64,
        y: f64,
        text: &str,
        font_size: f64,
        width: f64,
        height: f64,
        style: Style,
    ) -> String {
        self.insert(
            style,
            Shape::Text {
                x,
                y,
                width: width.max(0.0),
                height: height.max(0.0),
                text: text.to_owned(),
                font_size,
            },
        )
    }

    /// Cria uma imagem. O arquivo entra em `files` pela chave `file_id`; se a chave já
    /// existir (a mesma imagem colada de novo), o conteúdo guardado é reaproveitado.
    #[allow(clippy::too_many_arguments)]
    pub fn add_image(
        &mut self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        file_id: &str,
        mime_type: &str,
        data_url: &str,
    ) -> String {
        self.doc
            .files
            .entry(file_id.to_owned())
            .or_insert_with(|| ImageFile {
                mime_type: mime_type.to_owned(),
                data_url: data_url.to_owned(),
            });
        let style = Style {
            stroke_width: 0.0,
            roughness: 0.0,
            ..Style::default()
        };
        self.insert(
            style,
            Shape::Image {
                x,
                y,
                width: width.max(MIN_SIZE),
                height: height.max(MIN_SIZE),
                file_id: file_id.to_owned(),
            },
        )
    }

    pub fn file(&self, file_id: &str) -> Option<&ImageFile> {
        self.doc.files.get(file_id)
    }

    /// Troca o conteúdo de um texto, com a nova medida.
    pub fn set_text(
        &mut self,
        id: &str,
        new_text: &str,
        new_width: f64,
        new_height: f64,
    ) -> Result<(), CoreError> {
        self.record(id);
        let el = self.element_mut(id)?;
        let Shape::Text {
            text,
            width,
            height,
            ..
        } = &mut el.shape
        else {
            return Err(CoreError::WrongKind(id.into()));
        };
        *text = new_text.to_owned();
        *width = new_width.max(0.0);
        *height = new_height.max(0.0);
        self.touch(id)
    }

    /// Desloca o elemento, qualquer que seja o tipo.
    pub fn translate(&mut self, id: &str, dx: f64, dy: f64) -> Result<(), CoreError> {
        self.record(id);
        self.element_mut(id)?.shape.translate(dx, dy);
        self.touch(id)
    }

    /// Redimensiona o elemento para caber em `to`, esticando a partir dos limites atuais.
    ///
    /// - Retângulo: passa a ter exatamente esses limites.
    /// - Traço livre: cada ponto é esticado na mesma proporção (a espessura não muda).
    /// - Seta: as duas pontas são esticadas na mesma proporção.
    /// - Boneco e imagem: passam a ter exatamente esses limites.
    /// - Texto: escala por igual pela altura, mudando o tamanho da fonte; fica no canto de `to`.
    ///
    /// Largura e altura nunca ficam abaixo de [`MIN_SIZE`], para o elemento não colapsar
    /// num ponto e perder o formato.
    pub fn resize(&mut self, id: &str, to: geometry::Bounds) -> Result<(), CoreError> {
        let from = self
            .bounds(id)
            .ok_or_else(|| CoreError::NotFound(id.into()))?;
        self.record(id);
        let to = geometry::Bounds {
            max_x: to.min_x + to.width().max(MIN_SIZE),
            max_y: to.min_y + to.height().max(MIN_SIZE),
            ..to
        };
        let ratio = |new: f64, old: f64| if old > 0.0 { new / old } else { 1.0 };
        let (sx, sy) = (
            ratio(to.width(), from.width()),
            ratio(to.height(), from.height()),
        );
        let el = self.element_mut(id)?;
        match &mut el.shape {
            Shape::Rectangle {
                x,
                y,
                width,
                height,
            }
            | Shape::Image {
                x,
                y,
                width,
                height,
                ..
            }
            | Shape::Figure {
                x,
                y,
                width,
                height,
            } => {
                (*x, *y, *width, *height) = (to.min_x, to.min_y, to.width(), to.height());
            }
            Shape::Arrow { points } => {
                for p in points {
                    p[0] = to.min_x + (p[0] - from.min_x) * sx;
                    p[1] = to.min_y + (p[1] - from.min_y) * sy;
                }
            }
            Shape::Freehand { points } => {
                for p in points {
                    p.x = to.min_x + (p.x - from.min_x) * sx;
                    p.y = to.min_y + (p.y - from.min_y) * sy;
                }
            }
            Shape::Text {
                x,
                y,
                width,
                height,
                font_size,
                ..
            } => {
                *x = to.min_x;
                *y = to.min_y;
                *width *= sy;
                *height *= sy;
                *font_size = (*font_size * sy).max(MIN_FONT_SIZE);
            }
        }
        self.touch(id)
    }

    pub fn bounds(&self, id: &str) -> Option<geometry::Bounds> {
        self.get(id).and_then(geometry::bounds)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), CoreError> {
        self.record(id);
        self.element_mut(id)?.deleted = true;
        self.touch(id)
    }

    /// O elemento visível mais à frente que o ponto acerta.
    pub fn hit_test(&self, x: f64, y: f64, tolerance: f64) -> Option<&str> {
        self.doc
            .visible()
            .rev()
            .find(|e| geometry::hit(e, x, y, tolerance))
            .map(|e| e.id.as_str())
    }

    pub fn render(&self, id: &str) -> Option<RenderPath> {
        self.get(id).map(render)
    }

    /// Junta uma cópia remota neste desenho (ver [`merge`]).
    pub fn merge_remote(&mut self, remote: &Document) {
        self.doc = merge(&self.doc, remote);
    }

    pub(crate) fn new_id(&mut self) -> String {
        format!("{:016x}", self.rng.next_u64())
    }

    fn insert(&mut self, style: Style, shape: Shape) -> String {
        let id = self.new_id();
        let element = Element {
            id: id.clone(),
            version: 1,
            nonce: self.rng.next_u32(),
            seed: self.rng.next_u32(),
            deleted: false,
            style,
            shape,
        };
        self.record_new(&id);
        self.doc.elements.push(element);
        id
    }

    pub(crate) fn element_mut(&mut self, id: &str) -> Result<&mut Element, CoreError> {
        self.doc
            .elements
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| CoreError::NotFound(id.into()))
    }

    pub(crate) fn touch(&mut self, id: &str) -> Result<(), CoreError> {
        let nonce = self.rng.next_u32();
        let el = self.element_mut(id)?;
        el.version = el.version.saturating_add(1);
        el.nonce = nonce;
        Ok(())
    }
}

fn normalize(x: f64, y: f64, w: f64, h: f64) -> (f64, f64, f64, f64) {
    (x.min(x + w), y.min(y + h), w.abs(), h.abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retangulo_novo_tem_id_versao_um_e_entra_no_fim() {
        let mut b = Board::new(1);
        let a = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        let c = b.add_rectangle(5.0, 5.0, 10.0, 10.0, Style::default());
        assert_ne!(a, c);
        assert_eq!(a.len(), 16);
        assert_eq!(b.visible_ids(), vec![a.clone(), c]);
        assert_eq!(b.get(&a).map(|e| e.version), Some(1));
    }

    #[test]
    fn sementes_diferentes_geram_ids_diferentes() {
        let a = Board::new(1).add_rectangle(0.0, 0.0, 1.0, 1.0, Style::default());
        let b = Board::new(2).add_rectangle(0.0, 0.0, 1.0, 1.0, Style::default());
        assert_ne!(a, b);
    }

    #[test]
    fn arrastar_para_cima_e_esquerda_normaliza_o_retangulo() {
        let mut b = Board::new(1);
        let id = b.add_rectangle(50.0, 50.0, 0.0, 0.0, Style::default());
        b.set_rectangle(&id, 50.0, 50.0, -30.0, -20.0)
            .expect("existe");
        let el = b.get(&id).expect("existe");
        assert_eq!(
            el.shape,
            Shape::Rectangle {
                x: 20.0,
                y: 30.0,
                width: 30.0,
                height: 20.0
            }
        );
        assert_eq!(el.version, 2);
    }

    #[test]
    fn mudar_retangulo_mantem_a_semente_e_troca_o_nonce() {
        let mut b = Board::new(1);
        let id = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        let before = b.get(&id).cloned().expect("existe");
        b.set_rectangle(&id, 0.0, 0.0, 20.0, 20.0).expect("existe");
        let after = b.get(&id).expect("existe");
        assert_eq!(before.seed, after.seed);
        assert_ne!(before.nonce, after.nonce);
    }

    #[test]
    fn traco_livre_ignora_pontos_colados() {
        let mut b = Board::new(1);
        let id = b.add_freehand(Point::new(0.0, 0.0), Style::default());
        assert_eq!(b.push_point(&id, Point::new(0.1, 0.1)).ok(), Some(false));
        assert_eq!(b.push_point(&id, Point::new(5.0, 0.0)).ok(), Some(true));
        let Some(Shape::Freehand { points }) = b.get(&id).map(|e| &e.shape) else {
            panic!("deveria ser traço livre");
        };
        assert_eq!(points.len(), 2);
    }

    #[test]
    fn tipo_errado_e_id_inexistente_dao_erro() {
        let mut b = Board::new(1);
        let r = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        assert!(matches!(
            b.push_point(&r, Point::new(1.0, 1.0)),
            Err(CoreError::WrongKind(_))
        ));
        assert!(matches!(b.delete("nada"), Err(CoreError::NotFound(_))));
    }

    #[test]
    fn apagar_esconde_mas_mantem_no_arquivo() {
        let mut b = Board::new(1);
        let id = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        b.delete(&id).expect("existe");
        assert!(b.visible_ids().is_empty());
        assert_eq!(b.document().elements.len(), 1);
        assert_eq!(b.hit_test(0.0, 5.0, 2.0), None);
    }

    #[test]
    fn clique_pega_o_elemento_da_frente() {
        let mut b = Board::new(1);
        let _back = b.add_rectangle(0.0, 0.0, 100.0, 100.0, Style::default());
        let front = b.add_rectangle(0.0, 0.0, 50.0, 50.0, Style::default());
        assert_eq!(b.hit_test(0.0, 25.0, 2.0), Some(front.as_str()));
    }

    #[test]
    fn texto_guarda_conteudo_e_medida() {
        let mut b = Board::new(1);
        let id = b.add_text(10.0, 20.0, "olá", 24.0, 40.0, 30.0, Style::default());
        b.set_text(&id, "olá\nmundo", 70.0, 60.0).expect("existe");
        let el = b.get(&id).expect("existe");
        assert_eq!(
            el.shape,
            Shape::Text {
                x: 10.0,
                y: 20.0,
                width: 70.0,
                height: 60.0,
                text: "olá\nmundo".into(),
                font_size: 24.0
            }
        );
        assert_eq!(el.version, 2);
        assert_eq!(el.shape.kind(), "text");
    }

    #[test]
    fn set_text_em_retangulo_da_erro() {
        let mut b = Board::new(1);
        let r = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        assert!(matches!(
            b.set_text(&r, "x", 1.0, 1.0),
            Err(CoreError::WrongKind(_))
        ));
    }

    #[test]
    fn clique_no_meio_do_texto_pega_o_texto() {
        let mut b = Board::new(1);
        let id = b.add_text(0.0, 0.0, "oi", 24.0, 40.0, 30.0, Style::default());
        assert_eq!(b.hit_test(20.0, 15.0, 1.0), Some(id.as_str()));
        assert_eq!(b.hit_test(80.0, 15.0, 1.0), None);
    }

    #[test]
    fn mover_desloca_todos_os_tipos() {
        let mut b = Board::new(1);
        let r = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        let f = b.add_freehand(Point::new(0.0, 0.0), Style::default());
        b.push_point(&f, Point::new(10.0, 5.0)).expect("existe");
        let t = b.add_text(1.0, 1.0, "a", 20.0, 10.0, 25.0, Style::default());
        for id in [&r, &f, &t] {
            b.translate(id, 5.0, -2.0).expect("existe");
        }
        let min = |id: &str| b.bounds(id).map(|bb| (bb.min_x, bb.min_y));
        assert_eq!(min(&r), Some((5.0, -2.0)));
        assert_eq!(min(&f), Some((5.0, -2.0)));
        assert_eq!(min(&t), Some((6.0, -1.0)));
        assert_eq!(b.get(&f).map(|e| e.version), Some(3));
    }

    fn b(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> geometry::Bounds {
        geometry::Bounds::from_corners(min_x, min_y, max_x, max_y)
    }

    #[test]
    fn redimensionar_retangulo() {
        let mut board = Board::new(1);
        let id = board.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        board.resize(&id, b(5.0, 5.0, 45.0, 25.0)).expect("existe");
        assert_eq!(board.bounds(&id), Some(b(5.0, 5.0, 45.0, 25.0)));
        assert_eq!(board.get(&id).map(|e| e.version), Some(2));
    }

    #[test]
    fn redimensionar_traco_livre_estica_os_pontos() {
        let mut board = Board::new(1);
        let id = board.add_freehand(Point::new(0.0, 0.0), Style::default());
        board
            .push_point(&id, Point::new(10.0, 5.0))
            .expect("existe");
        board
            .push_point(&id, Point::new(20.0, 10.0))
            .expect("existe");
        board
            .resize(&id, b(100.0, 100.0, 140.0, 110.0))
            .expect("existe");
        let Some(Shape::Freehand { points }) = board.get(&id).map(|e| &e.shape) else {
            panic!("deveria ser traço livre");
        };
        let xy: Vec<(f64, f64)> = points.iter().map(|p| (p.x, p.y)).collect();
        assert_eq!(xy, vec![(100.0, 100.0), (120.0, 105.0), (140.0, 110.0)]);
    }

    #[test]
    fn redimensionar_texto_muda_a_fonte_por_igual() {
        let mut board = Board::new(1);
        let id = board.add_text(0.0, 0.0, "oi", 20.0, 40.0, 25.0, Style::default());
        board
            .resize(&id, b(10.0, 10.0, 90.0, 60.0))
            .expect("existe");
        let el = board.get(&id).expect("existe");
        assert_eq!(
            el.shape,
            Shape::Text {
                x: 10.0,
                y: 10.0,
                width: 80.0,
                height: 50.0,
                text: "oi".into(),
                font_size: 40.0
            }
        );
    }

    #[test]
    fn redimensionar_nao_deixa_colapsar_e_volta_ao_formato() {
        let mut board = Board::new(1);
        let id = board.add_freehand(Point::new(0.0, 0.0), Style::default());
        board
            .push_point(&id, Point::new(10.0, 20.0))
            .expect("existe");
        board.resize(&id, b(0.0, 0.0, 0.0, 0.0)).expect("existe");
        assert_eq!(board.bounds(&id), Some(b(0.0, 0.0, 1.0, 1.0)));
        board.resize(&id, b(0.0, 0.0, 10.0, 20.0)).expect("existe");
        assert_eq!(board.bounds(&id), Some(b(0.0, 0.0, 10.0, 20.0)));
    }

    #[test]
    fn fonte_tem_tamanho_minimo() {
        let mut board = Board::new(1);
        let id = board.add_text(0.0, 0.0, "oi", 20.0, 40.0, 25.0, Style::default());
        board.resize(&id, b(0.0, 0.0, 1.0, 1.0)).expect("existe");
        assert!(matches!(
            board.get(&id).map(|e| &e.shape),
            Some(Shape::Text { font_size, .. }) if *font_size == MIN_FONT_SIZE
        ));
    }

    #[test]
    fn redimensionar_inexistente_da_erro() {
        let mut board = Board::new(1);
        assert!(matches!(
            board.resize("nada", b(0.0, 0.0, 1.0, 1.0)),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn imagem_guarda_o_arquivo_uma_vez_so() {
        let mut board = Board::new(1);
        let a = board.add_image(
            0.0,
            0.0,
            40.0,
            20.0,
            "f1",
            "image/png",
            "data:image/png;base64,AAA",
        );
        let c = board.add_image(
            50.0,
            0.0,
            40.0,
            20.0,
            "f1",
            "image/png",
            "data:image/png;base64,AAA",
        );
        assert_ne!(a, c);
        assert_eq!(board.document().files.len(), 1);
        assert_eq!(
            board.file("f1").map(|f| f.data_url.as_str()),
            Some("data:image/png;base64,AAA")
        );
        assert_eq!(board.get(&a).map(|e| e.shape.kind()), Some("image"));
    }

    #[test]
    fn imagem_responde_ao_clique_no_meio_move_e_redimensiona() {
        let mut board = Board::new(1);
        let id = board.add_image(0.0, 0.0, 40.0, 20.0, "f1", "image/png", "data:,");
        assert_eq!(board.hit_test(20.0, 10.0, 0.0), Some(id.as_str()));
        board.translate(&id, 10.0, 10.0).expect("existe");
        board
            .resize(&id, b(10.0, 10.0, 90.0, 50.0))
            .expect("existe");
        assert_eq!(board.bounds(&id), Some(b(10.0, 10.0, 90.0, 50.0)));
    }

    #[test]
    fn seta_cria_move_a_ponta_e_estica() {
        let mut board = Board::new(1);
        let id = board.add_arrow(vec![[0.0, 0.0]], Style::default());
        board.set_arrow_end(&id, 40.0, -20.0).expect("existe");
        assert_eq!(board.bounds(&id), Some(b(0.0, -20.0, 40.0, 0.0)));
        board.resize(&id, b(0.0, -40.0, 80.0, 0.0)).expect("existe");
        assert_eq!(
            board.get(&id).map(|e| e.shape.clone()),
            Some(Shape::Arrow {
                points: vec![[0.0, 0.0], [80.0, -40.0]]
            })
        );
        let r = board.add_rectangle(0.0, 0.0, 1.0, 1.0, Style::default());
        assert!(matches!(
            board.set_arrow_end(&r, 1.0, 1.0),
            Err(CoreError::WrongKind(_))
        ));
    }

    #[test]
    fn boneco_cria_normalizado_e_muda_como_caixa() {
        let mut board = Board::new(1);
        let id = board.add_figure(50.0, 100.0, -50.0, -100.0, Style::default());
        assert_eq!(board.bounds(&id), Some(b(0.0, 0.0, 50.0, 100.0)));
        board
            .set_frame(&id, 10.0, 10.0, 30.0, 60.0)
            .expect("existe");
        assert_eq!(board.bounds(&id), Some(b(10.0, 10.0, 40.0, 70.0)));
        assert_eq!(board.get(&id).map(|e| e.shape.kind()), Some("figure"));
        let t = board.add_text(0.0, 0.0, "a", 20.0, 10.0, 25.0, Style::default());
        assert!(matches!(
            board.set_frame(&t, 0.0, 0.0, 1.0, 1.0),
            Err(CoreError::WrongKind(_))
        ));
    }

    #[test]
    fn json_volta_igual() {
        let mut b = Board::new(1);
        b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        let id = b.add_freehand(Point::new(0.0, 0.0), Style::default());
        b.push_point(&id, Point::with_pressure(10.0, 10.0, 0.9))
            .expect("existe");
        b.add_text(0.0, 0.0, "oi", 24.0, 30.0, 30.0, Style::default());
        b.add_image(0.0, 0.0, 10.0, 10.0, "f", "image/png", "data:,");
        b.add_arrow(
            vec![[0.0, 0.0], [0.0, 10.0], [30.0, 10.0]],
            Style::default(),
        );
        b.add_figure(0.0, 0.0, 40.0, 80.0, Style::default());
        let json = b.to_json().expect("serializa");
        let back = Board::from_json(&json, 2).expect("lê");
        assert_eq!(back.document(), b.document());
    }

    #[test]
    fn merge_remoto_traz_elementos_do_outro_aparelho() {
        let mut phone = Board::new(1);
        let mut laptop = Board::new(2);
        let a = phone.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        let b = laptop.add_rectangle(5.0, 5.0, 10.0, 10.0, Style::default());
        phone.merge_remote(laptop.document());
        assert_eq!(phone.visible_ids(), vec![a, b]);
    }

    #[test]
    fn trocar_o_fundo_sobe_a_versao_e_vai_para_o_arquivo() {
        let mut board = Board::new(7);
        assert_eq!(board.background(), None);
        assert!(board.set_background("#1c1c1e"));
        assert!(!board.set_background("#1c1c1e"));
        assert!(board.set_background("#fdf0a6"));
        assert_eq!(
            board.document().background.as_ref().map(|b| b.version),
            Some(2)
        );
        let again = Board::from_json(&board.to_json().unwrap(), 1).unwrap();
        assert_eq!(again.background(), Some("#fdf0a6"));
    }

    #[test]
    fn arquivo_sem_fundo_continua_sem_o_campo() {
        let board = Board::new(7);
        assert!(!board.to_json().unwrap().contains("background"));
    }
}
