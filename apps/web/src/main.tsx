import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
// The studio control kit: element defaults and the `ui-` widgets Build, Architecture and
// World share. After the tokens, before any page stylesheet, so a mode can still override.
import './shell/controls.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
