import React from 'react';
import { Link } from 'react-router-dom';

export const NotFound = () => {
  return (
    <div data-easytag="id1-src/components/NotFound/index.jsx" style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:'24px'}}>
      <div style={{textAlign:'center',color:'#e5e7eb'}}>
        <h1 style={{fontSize:32,marginBottom:8}}>404 — Страница не найдена</h1>
        <p style={{opacity:0.8,marginBottom:16}}>Похоже, вы перешли по неверному адресу.</p>
        <Link to="/" style={{color:'#60a5fa',textDecoration:'none'}}>На главную</Link>
      </div>
    </div>
  );
};

export default NotFound;
