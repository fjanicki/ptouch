// Shared entry (frozen). Mounts the app; styles are owned by W4, PWA registration by W5.
import { mount } from 'svelte'
import './styles/base.css'
import App from './App.svelte'
import { registerServiceWorker } from './pwa/register'

const target = document.getElementById('app')
if (!target) throw new Error('#app missing')

export default mount(App, { target })

registerServiceWorker()
