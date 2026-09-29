import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ensureSeeded } from './lib/seed';
import './index.css';

// 首次进入灌入演示数据：评委点开链接看到的是有内容的工作台，而不是空表格。
// 库非空时不重复灌，用户自己的数据不会被覆盖。
ensureSeeded();

// 平台以静态资源托管，只支持 hash 路由（/#/…），不需要服务端 rewrite
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
