//! Ponte do núcleo do draw4fun para o navegador.
//!
//! Só traduz tipos: toda regra fica no `draw4fun-core`. Os testes desta ponte ficam no
//! lado web (`web/src/lib/core/*.test.ts`), que carrega o `.wasm` gerado de verdade.

use draw4fun_core::geometry::Bounds;
use draw4fun_core::{Board as CoreBoard, CoreError, Document, Point, Shape, Style};
use wasm_bindgen::prelude::*;

fn js_err(e: CoreError) -> JsError {
    JsError::new(&e.to_string())
}

fn seed(hi: u32, lo: u32) -> u64 {
    (u64::from(hi) << 32) | u64::from(lo)
}

fn style(stroke_color: String, stroke_width: f64, roughness: f64) -> Style {
    Style {
        stroke_color,
        stroke_width,
        roughness,
    }
}

/// Um desenho aberto. A semente vem em duas metades de 32 bits porque `u64` vira `BigInt`
/// no JS, e números aleatórios de `crypto.getRandomValues` já vêm em `Uint32Array`.
#[wasm_bindgen]
pub struct Board {
    inner: CoreBoard,
}

#[wasm_bindgen]
impl Board {
    #[wasm_bindgen(constructor)]
    pub fn new(seed_hi: u32, seed_lo: u32) -> Board {
        Board {
            inner: CoreBoard::new(seed(seed_hi, seed_lo)),
        }
    }

    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: &str, seed_hi: u32, seed_lo: u32) -> Result<Board, JsError> {
        CoreBoard::from_json(json, seed(seed_hi, seed_lo))
            .map(|inner| Board { inner })
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsError> {
        self.inner.to_json().map_err(js_err)
    }

    /// Ids dos elementos visíveis, do fundo para a frente.
    #[wasm_bindgen(js_name = visibleIds)]
    pub fn visible_ids(&self) -> Vec<String> {
        self.inner.visible_ids()
    }

    #[wasm_bindgen(js_name = addRectangle)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_rectangle(
        &mut self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        stroke_color: String,
        stroke_width: f64,
        roughness: f64,
    ) -> String {
        self.inner.add_rectangle(
            x,
            y,
            width,
            height,
            style(stroke_color, stroke_width, roughness),
        )
    }

    #[wasm_bindgen(js_name = setRectangle)]
    pub fn set_rectangle(
        &mut self,
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), JsError> {
        self.inner
            .set_rectangle(id, x, y, width, height)
            .map_err(js_err)
    }

    /// Como `setRectangle`, para qualquer caixa: retângulo ou boneco.
    #[wasm_bindgen(js_name = setFrame)]
    pub fn set_frame(
        &mut self,
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), JsError> {
        self.inner
            .set_frame(id, x, y, width, height)
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = addArrow)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_arrow(
        &mut self,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        stroke_color: String,
        stroke_width: f64,
        roughness: f64,
    ) -> String {
        self.inner.add_arrow(
            vec![[x1, y1], [x2, y2]],
            style(stroke_color, stroke_width, roughness),
        )
    }

    /// Move a ponta da seta.
    /// Linha por vários pontos (`[x0, y0, x1, y1, ...]`), com ou sem ponta de seta no fim.
    #[wasm_bindgen(js_name = addPolyline)]
    pub fn add_polyline(
        &mut self,
        coords: Vec<f64>,
        head: bool,
        color: String,
        width: f64,
        roughness: f64,
    ) -> String {
        let points = coords.as_chunks::<2>().0.to_vec();
        self.inner
            .add_polyline(points, head, style(color, width, roughness))
    }

    #[wasm_bindgen(js_name = setArrowEnd)]
    pub fn set_arrow_end(&mut self, id: &str, x: f64, y: f64) -> Result<(), JsError> {
        self.inner.set_arrow_end(id, x, y).map_err(js_err)
    }

    #[wasm_bindgen(js_name = addFigure)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_figure(
        &mut self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        stroke_color: String,
        stroke_width: f64,
        roughness: f64,
    ) -> String {
        self.inner.add_figure(
            x,
            y,
            width,
            height,
            style(stroke_color, stroke_width, roughness),
        )
    }

    #[wasm_bindgen(js_name = addFreehand)]
    pub fn add_freehand(
        &mut self,
        x: f64,
        y: f64,
        pressure: f64,
        stroke_color: String,
        stroke_width: f64,
    ) -> String {
        self.inner.add_freehand(
            Point::with_pressure(x, y, pressure),
            style(stroke_color, stroke_width, 0.0),
        )
    }

    #[wasm_bindgen(js_name = pushPoint)]
    pub fn push_point(&mut self, id: &str, x: f64, y: f64, pressure: f64) -> Result<bool, JsError> {
        self.inner
            .push_point(id, Point::with_pressure(x, y, pressure))
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = addText)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_text(
        &mut self,
        x: f64,
        y: f64,
        text: &str,
        font_size: f64,
        width: f64,
        height: f64,
        color: String,
    ) -> String {
        self.inner
            .add_text(x, y, text, font_size, width, height, style(color, 0.0, 0.0))
    }

    /// Cria uma imagem. `file_id` deve vir do conteúdo (um hash): a mesma imagem colada
    /// de novo reaproveita o arquivo já guardado.
    #[wasm_bindgen(js_name = addImage)]
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
        self.inner
            .add_image(x, y, width, height, file_id, mime_type, data_url)
    }

    /// Chave do arquivo de uma imagem (`undefined` se não for imagem).
    #[wasm_bindgen(js_name = imageFileId)]
    pub fn image_file_id(&self, id: &str) -> Option<String> {
        match self.inner.get(id).map(|e| &e.shape) {
            Some(Shape::Image { file_id, .. }) => Some(file_id.clone()),
            _ => None,
        }
    }

    /// Data URL do arquivo guardado com essa chave.
    #[wasm_bindgen(js_name = fileDataUrl)]
    pub fn file_data_url(&self, file_id: &str) -> Option<String> {
        self.inner.file(file_id).map(|f| f.data_url.clone())
    }

    #[wasm_bindgen(js_name = setText)]
    pub fn set_text(
        &mut self,
        id: &str,
        text: &str,
        width: f64,
        height: f64,
    ) -> Result<(), JsError> {
        self.inner.set_text(id, text, width, height).map_err(js_err)
    }

    pub fn translate(&mut self, id: &str, dx: f64, dy: f64) -> Result<(), JsError> {
        self.inner.translate(id, dx, dy).map_err(js_err)
    }

    /// Redimensiona o elemento para os limites dados (ver `Board::resize` no núcleo).
    pub fn resize(
        &mut self,
        id: &str,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
    ) -> Result<(), JsError> {
        self.inner
            .resize(id, Bounds::from_corners(min_x, min_y, max_x, max_y))
            .map_err(js_err)
    }

    /// Limites do elemento como `[minX, minY, maxX, maxY]`, sem a espessura do traço.
    pub fn bounds(&self, id: &str) -> Option<Vec<f64>> {
        self.inner
            .bounds(id)
            .map(|b| vec![b.min_x, b.min_y, b.max_x, b.max_y])
    }

    /// Tipo do elemento: `"rectangle"`, `"freehand"`, `"text"`, `"image"`, `"arrow"` ou `"figure"`.
    pub fn kind(&self, id: &str) -> Option<String> {
        self.inner.get(id).map(|e| e.shape.kind().to_owned())
    }

    /// Conteúdo de um texto (`undefined` se não for texto).
    pub fn text(&self, id: &str) -> Option<String> {
        match self.inner.get(id).map(|e| &e.shape) {
            Some(Shape::Text { text, .. }) => Some(text.clone()),
            _ => None,
        }
    }

    #[wasm_bindgen(js_name = fontSize)]
    pub fn font_size(&self, id: &str) -> Option<f64> {
        match self.inner.get(id).map(|e| &e.shape) {
            Some(Shape::Text { font_size, .. }) => Some(*font_size),
            _ => None,
        }
    }

    /// Copia os elementos para o formato da área de transferência (JSON com as imagens junto).
    pub fn copy(&self, ids: Vec<String>) -> Result<String, JsError> {
        self.inner.copy(&ids).map_err(js_err)
    }

    /// Cola o que foi copiado. Com `x` e `y`, centra ali; sem, põe ao lado do original.
    /// Devolve os ids novos.
    pub fn paste(
        &mut self,
        json: &str,
        x: Option<f64>,
        y: Option<f64>,
    ) -> Result<Vec<String>, JsError> {
        let at = x.zip(y);
        self.inner.paste(json, at).map_err(js_err)
    }

    pub fn duplicate(&mut self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        self.inner.duplicate(&ids).map_err(js_err)
    }

    /// Fecha o passo do histórico em andamento (chame ao fim de cada gesto).
    #[wasm_bindgen(js_name = endStep)]
    pub fn end_step(&mut self) -> bool {
        self.inner.end_step()
    }

    pub fn undo(&mut self) -> bool {
        self.inner.undo()
    }

    pub fn redo(&mut self) -> bool {
        self.inner.redo()
    }

    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.inner.can_undo()
    }

    #[wasm_bindgen(js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.inner.can_redo()
    }

    pub fn remove(&mut self, id: &str) -> Result<(), JsError> {
        self.inner.delete(id).map_err(js_err)
    }

    #[wasm_bindgen(js_name = hitTest)]
    pub fn hit_test(&self, x: f64, y: f64, tolerance: f64) -> Option<String> {
        self.inner.hit_test(x, y, tolerance).map(str::to_owned)
    }

    /// Versão do elemento: muda a cada edição, serve de chave para cache de desenho.
    pub fn version(&self, id: &str) -> Option<u32> {
        self.inner.get(id).map(|e| e.version)
    }

    /// Cor de fundo do quadro, ou `undefined` para o padrão.
    pub fn background(&self) -> Option<String> {
        self.inner.background().map(str::to_string)
    }

    /// Troca a cor de fundo; `false` se já era essa.
    #[wasm_bindgen(js_name = setBackground)]
    pub fn set_background(&mut self, color: &str) -> bool {
        self.inner.set_background(color)
    }

    #[wasm_bindgen(js_name = strokeColor)]
    pub fn stroke_color(&self, id: &str) -> Option<String> {
        self.inner.get(id).map(|e| e.style.stroke_color.clone())
    }

    #[wasm_bindgen(js_name = strokeWidth)]
    pub fn stroke_width(&self, id: &str) -> Option<f64> {
        self.inner.get(id).map(|e| e.style.stroke_width)
    }

    /// Caminho do elemento no formato achatado de `RenderPath::to_flat`.
    pub fn path(&self, id: &str) -> Option<Vec<f64>> {
        self.inner.render(id).map(|p| p.to_flat())
    }

    /// Junta neste desenho uma cópia vinda de outro aparelho (JSON do arquivo).
    #[wasm_bindgen(js_name = mergeRemote)]
    pub fn merge_remote(&mut self, json: &str) -> Result<(), JsError> {
        let remote = Document::from_json(json).map_err(js_err)?;
        self.inner.merge_remote(&remote);
        Ok(())
    }
}

/// Versão do formato de arquivo que esta build escreve.
#[wasm_bindgen(js_name = schemaVersion)]
pub fn schema_version() -> u32 {
    draw4fun_core::SCHEMA_VERSION
}

/// Diz se um texto da área de transferência foi copiado do draw4fun.
#[wasm_bindgen(js_name = isClipboard)]
pub fn is_clipboard(text: &str) -> bool {
    draw4fun_core::is_clipboard(text)
}
