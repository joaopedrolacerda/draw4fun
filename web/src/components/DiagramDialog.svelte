<script lang="ts">
  // Janela de diagrama em Mermaid: texto à esquerda, prévia à direita. "Inserir" põe o
  // desenho no quadro como elementos editáveis (padrão) ou como imagem (veja lib/mermaid.ts).
  import type { LoadedImage } from '../lib/images';
  import { TEMPLATES, renderMermaid, renderMermaidShapes, type DiagramInsert } from '../lib/mermaid';

  let {
    title,
    initialCode,
    onInsert,
    onClose,
  }: {
    title: string;
    initialCode: string;
    onInsert: (result: DiagramInsert) => void;
    onClose: () => void;
  } = $props();

  /** Espera a pessoa parar de digitar antes de redesenhar a prévia. */
  const PREVIEW_DELAY_MS = 350;

  // Só o valor inicial importa: depois o texto é da pessoa.
  // svelte-ignore state_referenced_locally
  let code = $state(initialCode);
  let preview = $state<LoadedImage | null>(null);
  /** Código que gerou a prévia atual: se for o mesmo, "Inserir" reaproveita. */
  let previewCode = '';
  let error = $state<string | null>(null);
  let loading = $state(true);
  let inserting = $state(false);
  /** Elementos que dá para editar no quadro, ou uma imagem só (fica igual à prévia). */
  let mode = $state<'shapes' | 'image'>('shapes');
  let textarea: HTMLTextAreaElement | undefined = $state();
  let generation = 0;

  $effect(() => {
    textarea?.focus();
  });

  $effect(() => {
    const current = code;
    const mine = ++generation;
    loading = true;
    const timer = setTimeout(async () => {
      try {
        const image = await renderMermaid(current);
        if (mine !== generation) return;
        preview = image;
        previewCode = current;
        error = null;
      } catch (err) {
        if (mine !== generation) return;
        error = err instanceof Error ? err.message : String(err);
      } finally {
        if (mine === generation) loading = false;
      }
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  });

  async function insert(): Promise<void> {
    if (inserting) return;
    inserting = true;
    try {
      if (mode === 'shapes') {
        onInsert({ kind: 'shapes', shapes: await renderMermaidShapes(code) });
      } else {
        const image = preview && previewCode === code ? preview : await renderMermaid(code);
        onInsert({ kind: 'image', image });
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      inserting = false;
    }
  }

  function useTemplate(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    const template = TEMPLATES.find((t) => t.id === select.value);
    if (template) code = template.code;
    select.value = '';
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void insert();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && onClose()}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="diagram-title" tabindex="-1" onkeydown={onKeyDown}>
    <header>
      <h2 id="diagram-title">{title}</h2>
      <select aria-label="Trocar pelo exemplo de outro tipo" onchange={useTemplate}>
        <option value="">Trocar de exemplo…</option>
        {#each TEMPLATES as t (t.id)}
          <option value={t.id}>{t.label}</option>
        {/each}
      </select>
    </header>

    <div class="body">
      <textarea
        bind:this={textarea}
        bind:value={code}
        spellcheck="false"
        aria-label="Código Mermaid"
        aria-invalid={error !== null}
      ></textarea>
      <div class="preview" aria-live="polite" aria-busy={loading}>
        {#if preview}
          <img src={preview.dataUrl} alt="Prévia do diagrama" class:stale={error !== null || loading} />
        {:else if loading}
          <p class="hint">Carregando o Mermaid…</p>
        {/if}
      </div>
    </div>

    <p class="message" class:error={error !== null} role={error ? 'alert' : undefined}>
      {#if error}
        {error}
      {:else}
        Sintaxe do <a href="https://mermaid.js.org/intro/syntax-reference.html" target="_blank" rel="noreferrer">Mermaid</a>.
        {#if mode === 'shapes'}
          Cada caixa, seta e texto vira um elemento: dá para mover, apagar e editar no quadro.
        {:else}
          Entra como uma imagem só, igual à prévia: para mudar, edite aqui e insira de novo.
        {/if}
      {/if}
    </p>

    <div class="actions">
      <div class="mode" role="radiogroup" aria-label="Inserir como">
        <label><input type="radio" name="diagram-mode" value="shapes" bind:group={mode} /> Elementos editáveis</label>
        <label><input type="radio" name="diagram-mode" value="image" bind:group={mode} /> Imagem</label>
      </div>
      <button class="secondary" onclick={onClose}>Cancelar</button>
      <button class="primary" onclick={insert} disabled={inserting} title="Ctrl+Enter">Inserir</button>
    </div>
  </div>
</div>

<style>
  .mode {
    display: flex;
    gap: 14px;
    margin-right: auto;
    font-size: 13px;
  }

  .mode label {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }

  .backdrop {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgb(31 41 51 / 0.18);
  }

  .dialog {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(960px, 100%);
    height: min(620px, 100%);
    padding: 16px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    outline: none;
  }

  header {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: 16px;
  }

  select {
    padding: 6px 8px;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    background: var(--paper);
    font-size: 13px;
  }

  .body {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
    gap: 10px;
    min-height: 0;
  }

  textarea {
    padding: 10px;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    background: var(--paper);
    font: 13px/1.5 ui-monospace, 'SF Mono', Menlo, monospace;
    resize: none;
    tab-size: 4;
  }

  textarea:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }

  textarea[aria-invalid='true'] {
    border-color: #b91c1c;
  }

  .preview {
    position: relative;
    display: grid;
    place-items: center;
    min-height: 0;
    border: 1px dashed var(--panel-border);
    border-radius: 8px;
    background: white;
  }

  /* Encolhe para caber inteira na área, sem cortar (diagramas altos são comuns). */
  .preview img {
    position: absolute;
    inset: 12px;
    width: calc(100% - 24px);
    height: calc(100% - 24px);
    object-fit: contain;
    transition: opacity 0.15s;
  }

  .preview img.stale {
    opacity: 0.35;
  }

  .hint {
    color: var(--muted);
    font-size: 13px;
  }

  .message {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }

  .message.error {
    font-size: 13px;
    color: #b91c1c;
  }

  .message a {
    color: var(--accent);
  }

  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .actions button {
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 14px;
    cursor: pointer;
  }

  .actions button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .secondary {
    border: 1px solid var(--panel-border);
    background: var(--paper);
  }

  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: white;
  }

  @media (max-width: 700px) {
    .body {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 1fr;
    }
  }
</style>
