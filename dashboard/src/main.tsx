import React from 'react';
import ReactDOM from 'react-dom/client';
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
