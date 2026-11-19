//! Transforma elementos em caminhos prontos para desenhar, com o traço de esboço.
//!
//! O algoritmo é próprio: cada segmento vira duas curvas cúbicas com as pontas e os
//! pontos de controle levemente deslocados, o que dá a cara de traço feito à mão.
//! O deslocamento vem da semente do elemento, então o desenho é sempre o mesmo.

use crate::model::{Element, Point, Shape};
use crate::rng::Rng;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathCmd {
    MoveTo(f64, f64),
    LineTo(f64, f64),
    CubicTo(f64, f64, f64, f64, f64, f64),
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaintMode {
    /// Contorno com a espessura do estilo.
    Stroke,
    /// Preenchido com a cor do traço (o traço livre já vem com a largura no contorno).
    Fill,
    /// Texto: sem caminho, a plataforma desenha com a fonte dela.
    Text,
    /// Imagem: sem caminho, a plataforma desenha o arquivo nos limites do elemento.
    Image,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderPath {
    pub mode: PaintMode,
    pub commands: Vec<PathCmd>,
}

impl RenderPath {
    /// Formato achatado para atravessar pontes (WASM, FFI) sem cópia por comando:
    /// `[modo, op, args..., op, args...]`, com modo 0 = contorno, 1 = preenchido, 2 = texto, 3 = imagem, e
    /// op 0 = moveTo(x, y), 1 = lineTo(x, y), 2 = cubicTo(6 números), 3 = fechar.
    pub fn to_flat(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(1 + self.commands.len() * 7);
        out.push(match self.mode {
            PaintMode::Stroke => 0.0,
            PaintMode::Fill => 1.0,
            PaintMode::Text => 2.0,
            PaintMode::Image => 3.0,
        });
        for cmd in &self.commands {
            match *cmd {
                PathCmd::MoveTo(x, y) => out.extend([0.0, x, y]),
                PathCmd::LineTo(x, y) => out.extend([1.0, x, y]),
                PathCmd::CubicTo(a, b, c, d, e, f) => out.extend([2.0, a, b, c, d, e, f]),
                PathCmd::Close => out.push(3.0),
            }
        }
        out
    }
}

pub fn render(element: &Element) -> RenderPath {
    let mut rng = Rng::new(u64::from(element.seed));
    match &element.shape {
        Shape::Rectangle {
            x,
            y,
            width,
            height,
        } => {
            let corners = [
                (*x, *y),
                (x + width, *y),
                (x + width, y + height),
                (*x, y + height),
            ];
            let mut commands = Vec::with_capacity(16);
            for i in 0..4 {
                let (a, b) = (corners[i], corners[(i + 1) % 4]);
                sketchy_line(&mut rng, a, b, element.style.roughness, &mut commands);
            }
            RenderPath {
                mode: PaintMode::Stroke,
                commands,
            }
        }
        Shape::Freehand { points } => RenderPath {
            mode: PaintMode::Fill,
            commands: freehand_outline(points, element.style.stroke_width),
        },
        Shape::Text { .. } => RenderPath {
            mode: PaintMode::Text,
            commands: Vec::new(),
        },
        Shape::Image { .. } => RenderPath {
            mode: PaintMode::Image,
            commands: Vec::new(),
        },
        Shape::Arrow { points, head } => RenderPath {
            mode: PaintMode::Stroke,
            commands: arrow(&mut rng, points, *head, element.style.roughness),
        },
        Shape::Figure {
            x,
            y,
            width,
            height,
        } => RenderPath {
            mode: PaintMode::Stroke,
            commands: figure(&mut rng, *x, *y, *width, *height, element.style.roughness),
        },
    }
}

/// Ângulo de cada aba da ponta da seta em relação à haste.
const ARROW_HEAD_ANGLE: f64 = 0.45;
/// Comprimento máximo das abas da ponta da seta.
const ARROW_HEAD_MAX: f64 = 18.0;

/// Haste rabiscada (um trecho por par de pontos) mais duas abas curtas na ponta,
/// alinhadas com o último trecho.
fn arrow(rng: &mut Rng, points: &[[f64; 2]], with_head: bool, roughness: f64) -> Vec<PathCmd> {
    let mut out = Vec::with_capacity(8 * points.len());
    for w in points.windows(2) {
        sketchy_line(
            rng,
            (w[0][0], w[0][1]),
            (w[1][0], w[1][1]),
            roughness,
            &mut out,
        );
    }
    let Some(&[bx, by]) = points.last().filter(|_| with_head) else {
        return out;
    };
    let b = (bx, by);
    // Último trecho com comprimento: pontos repetidos no fim não dizem para onde a seta aponta.
    let Some(&[ax, ay]) = points
        .iter()
        .rev()
        .find(|p| (p[0] - bx).hypot(p[1] - by) > 1e-6)
    else {
        return out;
    };
    let (dx, dy) = (bx - ax, by - ay);
    let len = dx.hypot(dy);
    // Tamanho pela seta inteira (uma seta com dobra tem o último trecho curto), sem passar
    // do próprio último trecho.
    let total: f64 = points
        .windows(2)
        .map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]))
        .sum();
    let head = (total * 0.35).min(ARROW_HEAD_MAX).min(len);
    let back = dy.atan2(dx) + std::f64::consts::PI;
    for side in [-1.0, 1.0] {
        let angle = back + side * ARROW_HEAD_ANGLE;
        let tip = (b.0 + head * angle.cos(), b.1 + head * angle.sin());
        sketchy_line(rng, b, tip, roughness, &mut out);
    }
    out
}

/// Boneco de palitinho que ocupa a caixa: cabeça, tronco, braços e pernas.
fn figure(rng: &mut Rng, x: f64, y: f64, w: f64, h: f64, roughness: f64) -> Vec<PathCmd> {
    let mut out = Vec::with_capacity(40);
    let cx = x + w / 2.0;
    let head = (w * 0.6).min(h * 0.28);
    let r = head / 2.0;
    sketchy_ellipse(rng, (cx, y + r), r, r, roughness, &mut out);
    let neck = y + head;
    let hip = y + h * 0.65;
    let shoulder = neck + (hip - neck) * 0.25;
    let hand = shoulder + (hip - neck) * 0.35;
    let lines = [
        ((cx, neck), (cx, hip)),
        ((cx, shoulder), (x, hand)),
        ((cx, shoulder), (x + w, hand)),
        ((cx, hip), (x + w * 0.12, y + h)),
        ((cx, hip), (x + w * 0.88, y + h)),
    ];
    for (a, b) in lines {
        sketchy_line(rng, a, b, roughness, &mut out);
    }
    out
}

/// Elipse desenhada duas vezes, cada volta com raio e ponto de partida um pouco diferentes
/// e passando um pouquinho do começo, como quando se fecha um círculo à mão.
fn sketchy_ellipse(
    rng: &mut Rng,
    c: (f64, f64),
    rx: f64,
    ry: f64,
    roughness: f64,
    out: &mut Vec<PathCmd>,
) {
    let passes = if roughness <= 0.0 { 1 } else { 2 };
    for pass in 0..passes {
        let amp = if pass == 0 { 1.0 } else { 0.8 } * roughness;
        let (rx, ry) = (
            rx * (1.0 + rng.range(-0.06, 0.06) * amp),
            ry * (1.0 + rng.range(-0.06, 0.06) * amp),
        );
        let start = rng.range(0.0, std::f64::consts::TAU) * amp.min(1.0);
        let sweep = std::f64::consts::TAU + 0.25 * amp;
        let point = |a: f64| (c.0 + rx * a.cos(), c.1 + ry * a.sin());
        let p0 = point(start);
        out.push(PathCmd::MoveTo(p0.0, p0.1));
        // Cada quarto de volta vira uma cúbica (aproximação padrão de arco).
        let step = sweep / 4.0;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        for i in 0..4 {
            let a = start + step * f64::from(i);
            let b = a + step;
            let (pa, pb) = (point(a), point(b));
            out.push(PathCmd::CubicTo(
                pa.0 - k * rx * a.sin(),
                pa.1 + k * ry * a.cos(),
                pb.0 + k * rx * b.sin(),
                pb.1 - k * ry * b.cos(),
                pb.0,
                pb.1,
            ));
        }
    }
}

/// Uma linha de `a` a `b` desenhada duas vezes, cada vez com um tremido diferente.
fn sketchy_line(
    rng: &mut Rng,
    a: (f64, f64),
    b: (f64, f64),
    roughness: f64,
    out: &mut Vec<PathCmd>,
) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = (dx * dx + dy * dy).sqrt();
    if roughness <= 0.0 || len < 1e-6 {
        out.push(PathCmd::MoveTo(a.0, a.1));
        out.push(PathCmd::LineTo(b.0, b.1));
        return;
    }
    let (nx, ny) = (-dy / len, dx / len);
    // Linhas curtas tremem menos, para não virarem bolinhas.
    let end_jitter = roughness * (len * 0.08).min(2.5);
    let bow = roughness * (len * 0.03).min(5.0);
    for pass in 0..2 {
        let scale = if pass == 0 { 1.0 } else { 0.8 };
        let mut j = |amp: f64| rng.range(-amp, amp) * scale;
        let start = (a.0 + j(end_jitter), a.1 + j(end_jitter));
        let end = (b.0 + j(end_jitter), b.1 + j(end_jitter));
        let t1 = 0.3 + j(0.05);
        let t2 = 0.7 + j(0.05);
        let o1 = j(bow);
        let o2 = j(bow);
        out.push(PathCmd::MoveTo(start.0, start.1));
        out.push(PathCmd::CubicTo(
            a.0 + dx * t1 + nx * o1,
            a.1 + dy * t1 + ny * o1,
            a.0 + dx * t2 + nx * o2,
            a.1 + dy * t2 + ny * o2,
            end.0,
            end.1,
        ));
    }
}

const CAP_STEPS: usize = 6;

/// Contorno fechado de um traço livre, com largura que acompanha a pressão e pontas redondas.
fn freehand_outline(points: &[Point], stroke_width: f64) -> Vec<PathCmd> {
    let radius = |p: &Point| stroke_width * (0.35 + 0.65 * p.pressure);
    let pts = smooth(points);
    let mut commands = Vec::new();
    let Some(first) = pts.first() else {
        return commands;
    };

    if pts.len() == 1 {
        // Um toque só vira um pontinho redondo.
        let r = radius(first);
        let steps = CAP_STEPS * 2;
        for k in 0..steps {
            let a = std::f64::consts::TAU * k as f64 / steps as f64;
            let (x, y) = (first.x + r * a.cos(), first.y + r * a.sin());
            commands.push(if k == 0 {
                PathCmd::MoveTo(x, y)
            } else {
                PathCmd::LineTo(x, y)
            });
        }
        commands.push(PathCmd::Close);
        return commands;
    }

    let n = pts.len();
    let mut left = Vec::with_capacity(n);
    let mut right = Vec::with_capacity(n);
    let mut last_dir = (1.0, 0.0);
    let mut dirs = Vec::with_capacity(n);
    for i in 0..n {
        let prev = &pts[i.saturating_sub(1)];
        let next = &pts[(i + 1).min(n - 1)];
        let (tx, ty) = (next.x - prev.x, next.y - prev.y);
        let len = (tx * tx + ty * ty).sqrt();
        if len > 1e-9 {
            last_dir = (tx / len, ty / len);
        }
        dirs.push(last_dir);
        let (nx, ny) = (-last_dir.1, last_dir.0);
        let r = radius(&pts[i]);
        left.push((pts[i].x + nx * r, pts[i].y + ny * r));
        right.push((pts[i].x - nx * r, pts[i].y - ny * r));
    }

    commands.push(PathCmd::MoveTo(left[0].0, left[0].1));
    for p in &left[1..] {
        commands.push(PathCmd::LineTo(p.0, p.1));
    }
    push_cap(&mut commands, &pts[n - 1], dirs[n - 1], radius(&pts[n - 1]));
    for p in right.iter().rev() {
        commands.push(PathCmd::LineTo(p.0, p.1));
    }
    push_cap(
        &mut commands,
        &pts[0],
        (-dirs[0].0, -dirs[0].1),
        radius(&pts[0]),
    );
    commands.push(PathCmd::Close);
    commands
}

/// Meia-volta em torno de `p`, saindo do lado esquerdo (em relação a `dir`) até o direito.
fn push_cap(out: &mut Vec<PathCmd>, p: &Point, dir: (f64, f64), r: f64) {
    let (nx, ny) = (-dir.1, dir.0);
    for k in 1..CAP_STEPS {
        let a = std::f64::consts::PI * k as f64 / CAP_STEPS as f64;
        let (c, s) = (a.cos(), a.sin());
        out.push(PathCmd::LineTo(
            p.x + r * (nx * c + dir.0 * s),
            p.y + r * (ny * c + dir.1 * s),
        ));
    }
}

/// Média móvel de três pontos, mantendo as pontas no lugar.
fn smooth(points: &[Point]) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut out = Vec::with_capacity(points.len());
    out.push(points[0]);
    for w in points.windows(3) {
        out.push(Point {
            x: (w[0].x + w[1].x + w[2].x) / 3.0,
            y: (w[0].y + w[1].y + w[2].y) / 3.0,
            pressure: w[1].pressure,
        });
    }
    if let Some(last) = points.last() {
        out.push(*last);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Style;

    fn rect(seed: u32, roughness: f64) -> Element {
        Element {
            id: "r".into(),
            version: 1,
            nonce: 0,
            seed,
            deleted: false,
            style: Style {
                roughness,
                ..Style::default()
            },
            shape: Shape::Rectangle {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 60.0,
            },
        }
    }

    fn freehand(points: Vec<Point>) -> Element {
        Element {
            id: "f".into(),
            version: 1,
            nonce: 0,
            seed: 1,
            deleted: false,
            style: Style::default(),
            shape: Shape::Freehand { points },
        }
    }

    #[test]
    fn mesma_semente_desenha_igual() {
        assert_eq!(render(&rect(9, 1.0)), render(&rect(9, 1.0)));
    }

    #[test]
    fn semente_diferente_desenha_diferente() {
        assert_ne!(render(&rect(9, 1.0)), render(&rect(10, 1.0)));
    }

    #[test]
    fn sem_tremido_o_retangulo_e_reto() {
        let path = render(&rect(9, 0.0));
        assert_eq!(path.mode, PaintMode::Stroke);
        assert_eq!(
            path.commands,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
                PathCmd::MoveTo(100.0, 0.0),
                PathCmd::LineTo(100.0, 60.0),
                PathCmd::MoveTo(100.0, 60.0),
                PathCmd::LineTo(0.0, 60.0),
                PathCmd::MoveTo(0.0, 60.0),
                PathCmd::LineTo(0.0, 0.0),
            ]
        );
    }

    #[test]
    fn retangulo_rabiscado_tem_dois_tracos_por_lado_e_fica_perto_da_forma() {
        let path = render(&rect(3, 1.0));
        assert_eq!(path.commands.len(), 16);
        for cmd in &path.commands {
            let (x, y) = match *cmd {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => (x, y),
                PathCmd::CubicTo(_, _, _, _, x, y) => (x, y),
                PathCmd::Close => continue,
            };
            assert!(
                (-5.0..=105.0).contains(&x) && (-5.0..=65.0).contains(&y),
                "fugiu: {x}, {y}"
            );
        }
    }

    #[test]
    fn traco_livre_vira_contorno_fechado_preenchido() {
        let path = render(&freehand(vec![
            Point::new(0.0, 0.0),
            Point::new(10.0, 0.0),
            Point::new(20.0, 5.0),
        ]));
        assert_eq!(path.mode, PaintMode::Fill);
        assert!(matches!(path.commands.first(), Some(PathCmd::MoveTo(..))));
        assert_eq!(path.commands.last(), Some(&PathCmd::Close));
    }

    #[test]
    fn traco_livre_mais_pressionado_fica_mais_grosso() {
        let width_at_start = |pressure: f64| {
            let path = render(&freehand(vec![
                Point::with_pressure(0.0, 0.0, pressure),
                Point::with_pressure(100.0, 0.0, pressure),
            ]));
            match path.commands[0] {
                PathCmd::MoveTo(_, y) => y.abs(),
                _ => f64::NAN,
            }
        };
        assert!(width_at_start(1.0) > width_at_start(0.1));
    }

    #[test]
    fn um_toque_vira_pontinho() {
        let path = render(&freehand(vec![Point::new(5.0, 5.0)]));
        assert_eq!(path.commands.len(), CAP_STEPS * 2 + 1);
    }

    #[test]
    fn traco_livre_vazio_nao_desenha_nada() {
        assert!(render(&freehand(vec![])).commands.is_empty());
    }

    #[test]
    fn texto_nao_tem_caminho() {
        let el = Element {
            id: "t".into(),
            version: 1,
            nonce: 0,
            seed: 1,
            deleted: false,
            style: Style::default(),
            shape: Shape::Text {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
                text: "a".into(),
                font_size: 20.0,
            },
        };
        let path = render(&el);
        assert_eq!(path.mode, PaintMode::Text);
        assert_eq!(path.to_flat(), vec![2.0]);
    }

    fn element(shape: Shape, roughness: f64) -> Element {
        Element {
            id: "e".into(),
            version: 1,
            nonce: 0,
            seed: 4,
            deleted: false,
            style: Style {
                roughness,
                ..Style::default()
            },
            shape,
        }
    }

    fn ends(path: &RenderPath) -> Vec<(f64, f64)> {
        path.commands
            .iter()
            .filter_map(|c| match *c {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => Some((x, y)),
                PathCmd::CubicTo(_, _, _, _, x, y) => Some((x, y)),
                PathCmd::Close => None,
            })
            .collect()
    }

    #[test]
    fn seta_reta_tem_haste_e_duas_abas_voltando_da_ponta() {
        let path = render(&element(
            Shape::Arrow {
                points: vec![[0.0, 0.0], [100.0, 0.0]],
                head: true,
            },
            0.0,
        ));
        assert_eq!(path.mode, PaintMode::Stroke);
        let pts = ends(&path);
        assert_eq!(pts[..2], [(0.0, 0.0), (100.0, 0.0)]);
        // Abas: saem da ponta e voltam para trás, uma de cada lado.
        assert_eq!(pts[2], (100.0, 0.0));
        assert!(pts[3].0 < 100.0 && pts[5].0 < 100.0);
        assert!(pts[3].1 * pts[5].1 < 0.0, "abas do mesmo lado");
    }

    #[test]
    fn seta_com_dobra_aponta_pelo_ultimo_trecho() {
        let path = render(&element(
            Shape::Arrow {
                points: vec![[0.0, 0.0], [0.0, 50.0], [100.0, 50.0], [100.0, 50.0]],
                head: true,
            },
            0.0,
        ));
        let pts = ends(&path);
        // Três trechos (o último tem comprimento zero) e as abas voltando para a esquerda.
        assert_eq!(pts.len(), 3 * 2 + 4);
        assert!(pts[7].0 < 100.0 && pts[9].0 < 100.0);
    }

    #[test]
    fn linha_sem_ponta_so_tem_os_trechos() {
        let path = render(&element(
            Shape::Arrow {
                points: vec![[0.0, 0.0], [50.0, 0.0], [50.0, 50.0]],
                head: false,
            },
            0.0,
        ));
        assert_eq!(ends(&path).len(), 2 * 2);
    }

    #[test]
    fn boneco_fica_dentro_da_caixa() {
        let path = render(&element(
            Shape::Figure {
                x: 10.0,
                y: 20.0,
                width: 60.0,
                height: 100.0,
            },
            1.0,
        ));
        assert_eq!(path.mode, PaintMode::Stroke);
        // Cabeça (2 voltas de 1 + 4 comandos) e 5 linhas de 2 passadas (2 comandos cada).
        assert_eq!(path.commands.len(), 10 + 5 * 4);
        for (x, y) in ends(&path) {
            assert!(
                (5.0..=75.0).contains(&x) && (15.0..=125.0).contains(&y),
                "fugiu: {x}, {y}"
            );
        }
    }

    #[test]
    fn formato_achatado() {
        let path = RenderPath {
            mode: PaintMode::Fill,
            commands: vec![
                PathCmd::MoveTo(1.0, 2.0),
                PathCmd::CubicTo(1.0, 2.0, 3.0, 4.0, 5.0, 6.0),
                PathCmd::Close,
            ],
        };
        assert_eq!(
            path.to_flat(),
            vec![1.0, 0.0, 1.0, 2.0, 2.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 3.0]
        );
    }
}
