//! Geometria: limites dos elementos e teste de clique.

use crate::model::{Element, Point, Shape};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Bounds {
    /// Monta os limites a partir de dois cantos quaisquer.
    pub fn from_corners(ax: f64, ay: f64, bx: f64, by: f64) -> Bounds {
        Bounds {
            min_x: ax.min(bx),
            min_y: ay.min(by),
            max_x: ax.max(bx),
            max_y: ay.max(by),
        }
    }

    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.min_x && x <= self.max_x && y >= self.min_y && y <= self.max_y
    }

    pub fn expanded(&self, by: f64) -> Bounds {
        Bounds {
            min_x: self.min_x - by,
            min_y: self.min_y - by,
            max_x: self.max_x + by,
            max_y: self.max_y + by,
        }
    }
}

/// Limites do elemento, sem contar a espessura do traço.
pub fn bounds(element: &Element) -> Option<Bounds> {
    match &element.shape {
        Shape::Rectangle {
            x,
            y,
            width,
            height,
        } => Some(Bounds {
            min_x: x.min(x + width),
            min_y: y.min(y + height),
            max_x: x.max(x + width),
            max_y: y.max(y + height),
        }),
        Shape::Freehand { points } => {
            let first = points.first()?;
            let init = Bounds {
                min_x: first.x,
                min_y: first.y,
                max_x: first.x,
                max_y: first.y,
            };
            Some(points.iter().fold(init, |b, p| Bounds {
                min_x: b.min_x.min(p.x),
                min_y: b.min_y.min(p.y),
                max_x: b.max_x.max(p.x),
                max_y: b.max_y.max(p.y),
            }))
        }
        Shape::Text {
            x,
            y,
            width,
            height,
            ..
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
        } => Some(Bounds {
            min_x: *x,
            min_y: *y,
            max_x: x + width,
            max_y: y + height,
        }),
        Shape::Arrow { points, .. } => {
            let [x, y] = *points.first()?;
            let init = Bounds::from_corners(x, y, x, y);
            Some(points.iter().fold(init, |b, p| Bounds {
                min_x: b.min_x.min(p[0]),
                min_y: b.min_y.min(p[1]),
                max_x: b.max_x.max(p[0]),
                max_y: b.max_y.max(p[1]),
            }))
        }
    }
}

/// Distância do ponto `(px, py)` ao segmento `a`–`b`.
pub fn distance_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0)
    };
    let (cx, cy) = (ax + t * dx, ay + t * dy);
    ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
}

/// Diz se o ponto `(x, y)` acerta o elemento, com uma folga de `tolerance`.
///
/// Formas sem preenchimento só respondem no traço, como num quadro de verdade:
/// clicar no meio de um retângulo vazio não pega o retângulo.
pub fn hit(element: &Element, x: f64, y: f64, tolerance: f64) -> bool {
    let slack = tolerance + element.style.stroke_width / 2.0;
    let Some(b) = bounds(element) else {
        return false;
    };
    if !b.expanded(slack).contains(x, y) {
        return false;
    }
    match &element.shape {
        Shape::Rectangle { .. } => {
            let corners = [
                (b.min_x, b.min_y),
                (b.max_x, b.min_y),
                (b.max_x, b.max_y),
                (b.min_x, b.max_y),
            ];
            (0..4).any(|i| {
                let (a, c) = (corners[i], corners[(i + 1) % 4]);
                distance_to_segment(x, y, a.0, a.1, c.0, c.1) <= slack
            })
        }
        Shape::Freehand { points } => hit_polyline(points, x, y, slack),
        // Texto responde na caixa toda: ninguém mira na perninha de uma letra.
        Shape::Text { .. } => true,
        // Imagem é cheia: responde em qualquer ponto dela.
        Shape::Image { .. } => true,
        // Boneco é fininho demais para mirar no traço: responde na caixa toda.
        Shape::Figure { .. } => true,
        Shape::Arrow { points, .. } => points
            .windows(2)
            .any(|w| distance_to_segment(x, y, w[0][0], w[0][1], w[1][0], w[1][1]) <= slack),
    }
}

fn hit_polyline(points: &[Point], x: f64, y: f64, slack: f64) -> bool {
    match points {
        [] => false,
        [p] => ((x - p.x).powi(2) + (y - p.y).powi(2)).sqrt() <= slack,
        _ => points
            .windows(2)
            .any(|w| distance_to_segment(x, y, w[0].x, w[0].y, w[1].x, w[1].y) <= slack),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Style;

    fn element(shape: Shape) -> Element {
        Element {
            id: "e".into(),
            version: 1,
            nonce: 0,
            seed: 1,
            deleted: false,
            style: Style::default(),
            shape,
        }
    }

    #[test]
    fn limites_do_retangulo_com_largura_negativa() {
        let e = element(Shape::Rectangle {
            x: 10.0,
            y: 10.0,
            width: -5.0,
            height: 20.0,
        });
        assert_eq!(
            bounds(&e),
            Some(Bounds {
                min_x: 5.0,
                min_y: 10.0,
                max_x: 10.0,
                max_y: 30.0
            })
        );
    }

    #[test]
    fn limites_do_traco_livre() {
        let e = element(Shape::Freehand {
            points: vec![
                Point::new(3.0, 9.0),
                Point::new(-1.0, 4.0),
                Point::new(7.0, 5.0),
            ],
        });
        assert_eq!(
            bounds(&e),
            Some(Bounds {
                min_x: -1.0,
                min_y: 4.0,
                max_x: 7.0,
                max_y: 9.0
            })
        );
    }

    #[test]
    fn traco_livre_vazio_nao_tem_limites() {
        assert_eq!(bounds(&element(Shape::Freehand { points: vec![] })), None);
    }

    #[test]
    fn distancia_ao_segmento() {
        assert_eq!(distance_to_segment(5.0, 3.0, 0.0, 0.0, 10.0, 0.0), 3.0);
        assert_eq!(distance_to_segment(-4.0, 3.0, 0.0, 0.0, 10.0, 0.0), 5.0);
        assert_eq!(
            distance_to_segment(1.0, 1.0, 0.0, 0.0, 0.0, 0.0),
            2f64.sqrt()
        );
    }

    #[test]
    fn retangulo_responde_na_borda_e_nao_no_meio() {
        let e = element(Shape::Rectangle {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 50.0,
        });
        assert!(hit(&e, 50.0, 0.5, 2.0));
        assert!(hit(&e, 102.0, 25.0, 2.0));
        assert!(!hit(&e, 50.0, 25.0, 2.0));
        assert!(!hit(&e, 200.0, 25.0, 2.0));
    }

    #[test]
    fn seta_responde_perto_da_linha_e_tem_limites_dos_dois_pontos() {
        let e = element(Shape::Arrow {
            points: vec![[100.0, 0.0], [0.0, 100.0]],
            head: true,
        });
        assert_eq!(
            bounds(&e),
            Some(Bounds::from_corners(0.0, 0.0, 100.0, 100.0))
        );
        assert!(hit(&e, 50.0, 50.0, 2.0));
        assert!(!hit(&e, 10.0, 10.0, 2.0));
    }

    #[test]
    fn seta_com_dobra_responde_em_cada_trecho() {
        let e = element(Shape::Arrow {
            points: vec![[0.0, 0.0], [0.0, 50.0], [100.0, 50.0]],
            head: true,
        });
        assert_eq!(
            bounds(&e),
            Some(Bounds::from_corners(0.0, 0.0, 100.0, 50.0))
        );
        assert!(hit(&e, 1.0, 25.0, 2.0));
        assert!(hit(&e, 50.0, 49.0, 2.0));
        assert!(!hit(&e, 50.0, 25.0, 2.0));
    }

    #[test]
    fn boneco_responde_na_caixa_toda() {
        let e = element(Shape::Figure {
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 80.0,
        });
        assert!(hit(&e, 5.0, 70.0, 0.0));
        assert!(!hit(&e, 50.0, 70.0, 0.0));
    }

    #[test]
    fn traco_livre_responde_perto_da_linha() {
        let e = element(Shape::Freehand {
            points: vec![Point::new(0.0, 0.0), Point::new(100.0, 0.0)],
        });
        assert!(hit(&e, 50.0, 3.0, 2.0));
        assert!(!hit(&e, 50.0, 10.0, 2.0));
    }
}
