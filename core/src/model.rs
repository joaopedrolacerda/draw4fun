//! Modelo do documento, no formato que vai para o arquivo `.draw4fun`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;

/// Versão do formato do arquivo. Suba quando o formato mudar de um jeito que
/// versões antigas não saibam ler, e escreva a migração em [`Document::from_json`].
pub const SCHEMA_VERSION: u32 = 1;

fn default_pressure() -> f64 {
    0.5
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    /// Pressão da caneta, de 0 a 1. Mouse e dedo usam 0,5.
    #[serde(default = "default_pressure")]
    pub pressure: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Point {
            x,
            y,
            pressure: default_pressure(),
        }
    }

    pub fn with_pressure(x: f64, y: f64, pressure: f64) -> Self {
        Point {
            x,
            y,
            pressure: pressure.clamp(0.0, 1.0),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Style {
    pub stroke_color: String,
    pub stroke_width: f64,
    /// Quanto o traço treme: 0 é uma linha reta, 1 é o padrão, 2 é bem rabiscado.
    pub roughness: f64,
}

impl Default for Style {
    fn default() -> Self {
        Style {
            stroke_color: "#1f2933".into(),
            stroke_width: 2.0,
            roughness: 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Shape {
    Rectangle {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Freehand {
        points: Vec<Point>,
    },
    /// Texto em uma ou mais linhas (`\n`). Largura e altura vêm medidas pela plataforma,
    /// que é quem conhece a fonte; o núcleo usa para clique, seleção e limites.
    Text {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        text: String,
        font_size: f64,
    },
    /// Imagem. O conteúdo fica em [`Document::files`], pela chave `file_id`, para a mesma
    /// imagem colada duas vezes ocupar espaço uma vez só.
    Image {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        file_id: String,
    },
    /// Seta: linha que passa pelos pontos em ordem, com a ponta no último. Duas pontas é
    /// uma seta reta; mais pontos fazem dobras.
    Arrow {
        points: Vec<[f64; 2]>,
    },
    /// Boneco de palitinho dentro da caixa: cabeça redonda em cima, braços e pernas.
    Figure {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
}

impl Shape {
    /// Desloca a forma, qualquer que seja o tipo.
    pub fn translate(&mut self, dx: f64, dy: f64) {
        match self {
            Shape::Rectangle { x, y, .. }
            | Shape::Text { x, y, .. }
            | Shape::Image { x, y, .. }
            | Shape::Figure { x, y, .. } => {
                *x += dx;
                *y += dy;
            }
            Shape::Freehand { points } => {
                for p in points {
                    p.x += dx;
                    p.y += dy;
                }
            }
            Shape::Arrow { points } => {
                for p in points {
                    p[0] += dx;
                    p[1] += dy;
                }
            }
        }
    }

    /// Nome do tipo como aparece no JSON.
    pub fn kind(&self) -> &'static str {
        match self {
            Shape::Rectangle { .. } => "rectangle",
            Shape::Freehand { .. } => "freehand",
            Shape::Text { .. } => "text",
            Shape::Image { .. } => "image",
            Shape::Arrow { .. } => "arrow",
            Shape::Figure { .. } => "figure",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    /// Sobe a cada mudança. No merge, a versão maior vence.
    pub version: u32,
    /// Aleatório, trocado a cada mudança. Desempata versões iguais.
    pub nonce: u32,
    /// Semente do traço de esboço: fixa durante a vida do elemento.
    pub seed: u32,
    /// Elementos apagados ficam no arquivo para o merge saber que foram apagados.
    #[serde(default)]
    pub deleted: bool,
    pub style: Style,
    #[serde(flatten)]
    pub shape: Shape,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub schema_version: u32,
    /// Em ordem de desenho: o último fica por cima.
    pub elements: Vec<Element>,
    /// Conteúdo das imagens, pela chave que os elementos `image` usam.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub files: BTreeMap<String, ImageFile>,
}

/// Uma imagem guardada dentro do arquivo, como data URL (`data:image/png;base64,...`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub mime_type: String,
    pub data_url: String,
}

impl Default for Document {
    fn default() -> Self {
        Document {
            schema_version: SCHEMA_VERSION,
            elements: Vec::new(),
            files: BTreeMap::new(),
        }
    }
}

impl Document {
    pub fn from_json(json: &str) -> Result<Self, CoreError> {
        let doc: Document = serde_json::from_str(json)?;
        if doc.schema_version > SCHEMA_VERSION {
            return Err(CoreError::UnsupportedSchema(doc.schema_version));
        }
        Ok(doc)
    }

    pub fn to_json(&self) -> Result<String, CoreError> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn get(&self, id: &str) -> Option<&Element> {
        self.elements.iter().find(|e| e.id == id)
    }

    pub fn visible(&self) -> impl DoubleEndedIterator<Item = &Element> {
        self.elements.iter().filter(|e| !e.deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../fixtures/sample-board.json");

    #[test]
    fn le_o_fixture_de_exemplo() {
        let doc = Document::from_json(FIXTURE).expect("fixture válido");
        assert_eq!(doc.schema_version, 1);
        assert_eq!(doc.elements.len(), 5);
        assert!(
            matches!(&doc.elements[4].shape, Shape::Image { file_id, .. } if file_id == "9f86d081884c7d65")
        );
        assert_eq!(doc.files.len(), 1);
        assert!(
            matches!(&doc.elements[3].shape, Shape::Text { text, font_size, .. } if text == "Ideia boa\nrevisar amanhã" && *font_size == 24.0)
        );
        assert!(matches!(doc.elements[0].shape, Shape::Rectangle { width, .. } if width == 200.0));
        assert!(doc.elements[2].deleted);
    }

    #[test]
    fn ida_e_volta_pelo_json_nao_perde_nada() {
        let doc = Document::from_json(FIXTURE).expect("fixture válido");
        let json = doc.to_json().expect("serializa");
        let back = Document::from_json(&json).expect("lê de volta");
        assert_eq!(doc, back);
    }

    #[test]
    fn json_usa_camel_case_e_tipo_no_proprio_elemento() {
        let doc = Document::from_json(FIXTURE).expect("fixture válido");
        let json = doc.to_json().expect("serializa");
        assert!(json.contains("\"schemaVersion\":1"));
        assert!(json.contains("\"type\":\"rectangle\""));
        assert!(json.contains("\"strokeColor\""));
        assert!(json.contains("\"fontSize\":24"));
        assert!(json.contains("\"fileId\":\"9f86d081884c7d65\""));
        assert!(json.contains("\"dataUrl\""));
    }

    #[test]
    fn pressao_ausente_vira_meio() {
        let p: Point = serde_json::from_str(r#"{"x":1,"y":2}"#).expect("ponto");
        assert_eq!(p.pressure, 0.5);
    }

    #[test]
    fn documento_sem_imagens_nao_escreve_files() {
        let json = Document::default().to_json().expect("serializa");
        assert_eq!(json, r#"{"schemaVersion":1,"elements":[]}"#);
    }

    #[test]
    fn recusa_versao_do_futuro() {
        let err = Document::from_json(r#"{"schemaVersion":99,"elements":[]}"#);
        assert!(matches!(err, Err(CoreError::UnsupportedSchema(99))));
    }

    #[test]
    fn recusa_json_quebrado() {
        assert!(matches!(Document::from_json("{"), Err(CoreError::Json(_))));
    }
}
