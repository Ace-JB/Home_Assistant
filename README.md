# Home Assistant

Local Bun + React app for a home monitoring assistant. The frontend is served
from `src/index.html`; runtime modules for camera, audio, sync buffering, face
recognition, and emergency recording live under `src/server`.

To install dependencies:

```bash
bun install
```

To start a development server:

```bash
bun dev
```

To run static checks and a production build:

```bash
bun run check
```

To run for production:

```bash
bun start
```
