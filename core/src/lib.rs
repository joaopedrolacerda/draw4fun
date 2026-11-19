//! Núcleo do draw4fun.
//!
//! Tudo o que não depende de plataforma fica aqui: o modelo do documento, a geometria,
//! o traço de esboço, o JSON e o merge entre duas cópias do mesmo desenho. A web usa este
//! crate pelo `draw4fun-core-wasm`; o app Swift vai usar pelo UniFFI.

pub mod board;
pub mod clipboard;
pub mod error;
pub mod geometry;
pub mod history;
pub mod merge;
pub mod model;
pub mod render;
pub mod rng;

pub use board::Board;
pub use clipboard::{CLIPBOARD_KIND, PASTE_OFFSET, is_clipboard};
pub use error::CoreError;
pub use merge::merge;
pub use model::{Document, Element, Point, SCHEMA_VERSION, Shape, Style};
pub use render::{PaintMode, PathCmd, RenderPath, render};
