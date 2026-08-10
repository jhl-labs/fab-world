import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import { FabApp } from './app'

createRoot(document.getElementById('root')!).render(<StrictMode><FabApp /></StrictMode>)
