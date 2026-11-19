import { mount } from 'svelte';
import '@fontsource/kalam/400.css';
import App from './App.svelte';
import { migrateLegacyStorage } from './lib/storage';
import './app.css';

// O app se chamava Rabisco: traz o que ficou salvo com os nomes antigos antes de ler qualquer coisa.
migrateLegacyStorage();

const target = document.getElementById('app');
if (!target) throw new Error('elemento #app não encontrado');

export default mount(App, { target });
