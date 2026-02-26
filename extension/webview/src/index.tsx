import React from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from './chat';

declare const acquireVsCodeApi: () => { postMessage: (message: unknown) => void };

const vscode = acquireVsCodeApi();

const rootEl = document.getElementById('root');
if (rootEl) {
  const root = createRoot(rootEl);
  root.render(<Chat vscode={vscode} />);
}
