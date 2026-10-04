import React from 'react';
import ReactDOM from 'react-dom/client';
// Fonts are bundled by Vite from the @fontsource packages (no CDN, works offline):
// Inter for the UI, JetBrains Mono for numbers, URLs, commands and model names.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import App from './App';
import './index.css';
import { applyTheme, readTheme } from './lib/theme';
import { setToken } from './lib/api';

// The token travels in the page hash and stays in memory only. Read it
// before the first render so no request goes out without it.
const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
const token = frag.get('token');
if (token) setToken(token);
applyTheme(readTheme());
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
