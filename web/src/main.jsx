import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import App from './App.jsx'
import { KioskV4Prototype } from './kioskPrototypeUi.jsx'
import './app.css'
import './kioskTheme.css'

const prototypeStage = new URLSearchParams(window.location.search).get('kioskPrototype')

createRoot(document.getElementById('root')).render(
  prototypeStage
    ? <KioskV4Prototype initialStage={prototypeStage} />
    : <App />
)
