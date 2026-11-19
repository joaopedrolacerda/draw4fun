<script lang="ts">
  import Icon from './Icon.svelte';
  import type { DriveUiState } from '../lib/drive/controller';

  let {
    status,
    detail,
    folderUrl,
    onConnect,
    onSync,
    onDisconnect,
  }: {
    status: DriveUiState;
    detail: string | null;
    folderUrl: string | null;
    onConnect: (mode: 'consent' | 'silent') => void;
    onSync: () => void;
    onDisconnect: () => void;
  } = $props();

  let open = $state(false);

  const labels: Record<DriveUiState, string> = {
    off: 'Entrar com Google',
    connecting: 'Conectando…',
    'needs-auth': 'Reconectar ao Drive',
    syncing: 'Sincronizando…',
    synced: 'Salvo no Drive',
    offline: 'Sem internet',
    error: 'Erro no Drive',
  };

  const explanations: Partial<Record<DriveUiState, string>> = {
    offline: 'As mudanças ficam neste navegador e vão para o Drive quando a internet voltar.',
    'needs-auth': 'O acesso ao Drive dura cerca de 1 hora. As mudanças ficam guardadas aqui até você reconectar.',
  };

  function close(): void {
    open = false;
  }
</script>

<svelte:window onpointerdown={(e) => open && !(e.target as Element).closest?.('.drive') && close()} />

<div class="drive">
  {#if status === 'off'}
    <button class="action" onclick={() => onConnect('consent')} title="Salvar e sincronizar este quadro no seu Google Drive">
      <Icon name="cloud" size={18} />
      {labels.off}
    </button>
  {:else if status === 'needs-auth'}
    <button class="action warn" onclick={() => onConnect('silent')} title={explanations['needs-auth']}>
      <Icon name="cloud" size={18} />
      {labels['needs-auth']}
    </button>
  {:else if status === 'connecting'}
    <span class="pill" aria-live="polite"><span class="dot syncing"></span>{labels.connecting}</span>
  {:else}
    <button class="pill" aria-expanded={open} aria-haspopup="menu" onclick={() => (open = !open)}>
      <span class="dot {status}"></span>
      <span aria-live="polite">{labels[status]}</span>
    </button>
    {#if open}
      <div class="menu" role="menu">
        {#if detail || explanations[status]}
          <p class="detail">{detail ?? explanations[status]}</p>
        {/if}
        <button role="menuitem" onclick={() => (close(), onSync())}>Sincronizar agora</button>
        {#if folderUrl}
          <a role="menuitem" href={folderUrl} target="_blank" rel="noopener noreferrer" onclick={close}>Abrir pasta no Drive</a>
        {/if}
        <button role="menuitem" class="danger" onclick={() => (close(), onDisconnect())}>Sair da conta Google</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .drive {
    position: absolute;
    top: max(12px, env(safe-area-inset-top));
    right: max(12px, env(safe-area-inset-right));
  }

  .action,
  .pill {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    padding: 0 14px;
    border: 1px solid var(--panel-border);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--shadow);
    font-size: 14px;
    cursor: pointer;
  }

  .action:hover,
  button.pill:hover {
    background: #f6f4ef;
  }

  .action.warn {
    color: #9a3412;
  }

  span.pill {
    cursor: default;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }

  .dot.synced {
    background: #15803d;
  }

  .dot.syncing {
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }

  .dot.offline {
    background: #a16207;
  }

  .dot.error {
    background: #b91c1c;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    display: flex;
    flex-direction: column;
    min-width: 230px;
    padding: 6px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }

  .menu button,
  .menu a {
    padding: 9px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text);
    font-size: 14px;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }

  .menu button:hover,
  .menu a:hover {
    background: #f3f1ec;
  }

  .menu .danger {
    color: #b91c1c;
  }

  .detail {
    margin: 4px 10px 8px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--muted);
  }

  /* Telas estreitas: desce para não brigar com a barra de ferramentas. */
  @media (max-width: 900px) {
    .drive {
      top: calc(max(12px, env(safe-area-inset-top)) + 60px);
    }
  }
</style>
