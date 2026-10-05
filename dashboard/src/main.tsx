import React from 'react';
import ReactDOM from 'react-dom/client';
// Fonts are bundled by Vite from the @fontsource-variable packages (no CDN,
// works offline): Inter for all UI text and numbers, Geist Mono only for
// run ids, commands and code.
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
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
