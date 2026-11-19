//! Desfazer e refazer.
//!
//! Cada passo guarda, para cada elemento que mudou, como ele estava antes e como ficou
//! depois. Um passo junta tudo o que aconteceu entre duas chamadas de [`Board::end_step`]:
//! a plataforma chama ao fim de cada gesto, então arrastar um retângulo por cem eventos
//! de ponteiro vira um passo só.
//!
//! Desfazer não volta a `version` do elemento: grava o conteúdo antigo como uma mudança
//! nova (versão maior). Assim o merge com o Drive entende o desfazer como a edição mais
//! recente, em vez de achar que a cópia remota é mais nova.

use crate::board::Board;
use crate::model::Element;

/// Quantos passos ficam guardados. Os mais antigos saem primeiro.
pub const MAX_STEPS: usize = 200;

#[derive(Debug, Clone, PartialEq)]
struct Change {
    id: String,
    /// `None`: o elemento não existia antes do passo.
    before: Option<Element>,
    after: Option<Element>,
}

impl Change {
    /// Mudança que não muda nada visível: criado e apagado no mesmo passo (um clique sem
    /// arrastar com o retângulo, um risco cancelado pela pinça), ou igual antes e depois.
    fn is_noop(&self) -> bool {
        let gone = |e: &Option<Element>| e.as_ref().is_none_or(|e| e.deleted);
        self.before == self.after || (gone(&self.before) && gone(&self.after))
    }
}

type Step = Vec<Change>;

#[derive(Debug, Clone, Default)]
pub struct History {
    undo: Vec<Step>,
    redo: Vec<Step>,
    /// Como estavam os elementos tocados no passo em andamento, antes da primeira mudança.
    pending: Vec<(String, Option<Element>)>,
}

impl Board {
    /// Guarda o estado de um elemento existente antes de mexer nele (só na primeira vez do passo).
    pub(crate) fn record(&mut self, id: &str) {
        if self.history.pending.iter().any(|(p, _)| p == id) {
            return;
        }
        if let Some(before) = self.get(id).cloned() {
            self.history.pending.push((id.to_owned(), Some(before)));
        }
    }

    /// Marca um elemento que está sendo criado agora.
    pub(crate) fn record_new(&mut self, id: &str) {
        if !self.history.pending.iter().any(|(p, _)| p == id) {
            self.history.pending.push((id.to_owned(), None));
        }
    }

    /// Fecha o passo em andamento. Devolve `true` se ele mudou alguma coisa e foi guardado.
    pub fn end_step(&mut self) -> bool {
        let pending = std::mem::take(&mut self.history.pending);
        let step: Step = pending
            .into_iter()
            .map(|(id, before)| {
                let after = self.get(&id).cloned();
                Change { id, before, after }
            })
            .filter(|c| !c.is_noop())
            .collect();
        if step.is_empty() {
            return false;
        }
        self.history.undo.push(step);
        if self.history.undo.len() > MAX_STEPS {
            self.history.undo.remove(0);
        }
        self.history.redo.clear();
        true
    }

    pub fn can_undo(&self) -> bool {
        !self.history.undo.is_empty() || !self.history.pending.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.history.redo.is_empty()
    }

    /// Desfaz o último passo (fechando antes o que estiver em andamento).
    /// Devolve `false` se não havia o que desfazer.
    pub fn undo(&mut self) -> bool {
        self.end_step();
        let Some(step) = self.history.undo.pop() else {
            return false;
        };
        for change in step.iter().rev() {
            self.restore(&change.id, change.before.as_ref());
        }
        self.history.redo.push(step);
        true
    }

    /// Refaz o último passo desfeito. Devolve `false` se não havia o que refazer.
    pub fn redo(&mut self) -> bool {
        self.end_step();
        let Some(step) = self.history.redo.pop() else {
            return false;
        };
        for change in &step {
            self.restore(&change.id, change.after.as_ref());
        }
        self.history.undo.push(step);
        true
    }

    /// Põe no elemento o conteúdo de `state` (ou apaga, se `None`) como uma mudança nova.
    fn restore(&mut self, id: &str, state: Option<&Element>) {
        let Ok(el) = self.element_mut(id) else {
            return;
        };
        match state {
            Some(s) => {
                el.shape = s.shape.clone();
                el.style = s.style.clone();
                el.deleted = s.deleted;
            }
            None => el.deleted = true,
        }
        // O elemento existe (acabamos de achá-lo), então `touch` não falha.
        let _ = self.touch(id);
    }
}

#[cfg(test)]
mod tests {
    use crate::board::Board;
    use crate::model::{Point, Shape, Style};

    fn rect_x(board: &Board, id: &str) -> Option<f64> {
        match board.get(id).map(|e| &e.shape) {
            Some(Shape::Rectangle { x, .. }) => Some(*x),
            _ => None,
        }
    }

    #[test]
    fn desfazer_criacao_some_com_o_elemento_e_refazer_traz_de_volta() {
        let mut b = Board::new(1);
        let r = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        assert!(b.end_step());
        assert!(b.undo());
        assert!(b.visible_ids().is_empty());
        assert!(b.can_redo());
        assert!(b.redo());
        assert_eq!(b.visible_ids(), vec![r]);
    }

    #[test]
    fn gesto_inteiro_vira_um_passo_so() {
        let mut b = Board::new(1);
        let r = b.add_rectangle(0.0, 0.0, 0.0, 0.0, Style::default());
        for i in 1..=50 {
            b.set_rectangle(&r, 0.0, 0.0, f64::from(i), f64::from(i))
                .expect("existe");
        }
        b.end_step();
        let f = b.add_freehand(Point::new(0.0, 0.0), Style::default());
        for i in 1..=50 {
            b.push_point(&f, Point::new(f64::from(i), 0.0))
                .expect("existe");
        }
        b.end_step();
        assert!(b.undo());
        assert_eq!(b.visible_ids(), vec![r.clone()]);
        assert!(b.undo());
        assert!(b.visible_ids().is_empty());
        assert!(!b.undo());
    }

    #[test]
    fn desfazer_mover_volta_a_posicao() {
        let mut b = Board::new(1);
        let r = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        b.end_step();
        b.translate(&r, 30.0, 0.0).expect("existe");
        b.translate(&r, 20.0, 0.0).expect("existe");
        b.end_step();
        b.undo();
        assert_eq!(rect_x(&b, &r), Some(0.0));
        b.redo();
        assert_eq!(rect_x(&b, &r), Some(50.0));
    }

    #[test]
    fn desfazer_apagar_traz_de_volta() {
        let mut b = Board::new(1);
        let r = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        b.end_step();
        b.delete(&r).expect("existe");
        b.end_step();
        b.undo();
        assert_eq!(b.visible_ids(), vec![r]);
    }

    #[test]
    fn desfazer_e_uma_mudanca_nova_para_o_merge() {
        let mut b = Board::new(1);
        let r = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        b.end_step();
        b.translate(&r, 30.0, 0.0).expect("existe");
        b.end_step();
        let moved = b.get(&r).map(|e| e.version).unwrap_or_default();
        b.undo();
        let undone = b.get(&r).map(|e| e.version).unwrap_or_default();
        assert!(
            undone > moved,
            "desfazer precisa subir a versão: {undone} <= {moved}"
        );
    }

    #[test]
    fn passo_sem_efeito_nao_entra_no_historico() {
        let mut b = Board::new(1);
        // Clique sem arrastar com o retângulo: cria e apaga no mesmo gesto.
        let r = b.add_rectangle(0.0, 0.0, 0.0, 0.0, Style::default());
        b.delete(&r).expect("existe");
        assert!(!b.end_step());
        // Ponto colado no anterior não muda nada.
        let f = b.add_freehand(Point::new(0.0, 0.0), Style::default());
        b.end_step();
        b.push_point(&f, Point::new(0.1, 0.0)).expect("existe");
        assert!(!b.end_step());
        assert!(b.undo());
        assert!(!b.can_undo());
    }

    #[test]
    fn mudanca_nova_apaga_o_refazer() {
        let mut b = Board::new(1);
        b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        b.end_step();
        b.undo();
        assert!(b.can_redo());
        b.add_rectangle(5.0, 5.0, 10.0, 10.0, Style::default());
        b.end_step();
        assert!(!b.can_redo());
    }

    #[test]
    fn desfazer_fecha_o_passo_em_andamento() {
        let mut b = Board::new(1);
        b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        assert!(b.can_undo());
        assert!(b.undo());
        assert!(b.visible_ids().is_empty());
    }

    #[test]
    fn desfazer_colar_tira_as_copias() {
        let mut b = Board::new(1);
        let r = b.add_rectangle(0.0, 0.0, 10.0, 10.0, Style::default());
        b.end_step();
        b.duplicate(std::slice::from_ref(&r)).expect("duplica");
        b.end_step();
        assert_eq!(b.visible_ids().len(), 2);
        b.undo();
        assert_eq!(b.visible_ids(), vec![r]);
    }

    #[test]
    fn historico_tem_limite() {
        let mut b = Board::new(1);
        for i in 0..(super::MAX_STEPS + 10) {
            b.add_rectangle(i as f64, 0.0, 1.0, 1.0, Style::default());
            b.end_step();
        }
        let mut undone = 0;
        while b.undo() {
            undone += 1;
        }
        assert_eq!(undone, super::MAX_STEPS);
    }
}
