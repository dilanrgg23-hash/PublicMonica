# Balanceador Unite

Arma equipos parejos de **Pokémon Unite** (Púrpura vs Naranja) a partir de los
nombres de usuario. Calcula un "nivel" por jugador combinando rango, Puntos de
Maestro / clase, % de victorias y experiencia, y reparte a los 10 jugadores en
dos equipos lo más equilibrados posible.

## Contenido

| Archivo | Qué es |
|---|---|
| `balanceador-unite.html` | La página completa (un solo archivo: HTML + CSS + JS). Funciona sola en **modo demo**. |
| `server.js` | Backend Node/Express que obtiene los datos reales por usuario desde [UniteAPI](https://uniteapi.dev). |
| `package.json` | Dependencias del backend (`express`, `cors`). |

## Cómo funciona

1. Metes hasta 10 usuarios y pulsas **Buscar y balancear**.
2. Para cada uno se obtiene rango, % de victorias y partidas, y se calcula un
   **nivel** combinado:
   - **Rango** como base. En *Maestro* suma los Puntos de Maestro; en los demás
     rangos suma según la clase (1 = alta).
   - **Ajuste por % de victorias**, pesado por el nº de partidas (más partidas =
     más fiable).
   - **Bono de experiencia** con rendimientos decrecientes.
3. Se arma **Equipo Púrpura vs Naranja** buscando el reparto con menor diferencia
   de nivel. Una barra tipo jaloneo muestra el equilibrio y se ilumina en cian
   cuando los equipos están parejos.
4. **Rebalancear** ofrece otros repartos casi igual de parejos; el deslizador de
   **Variación** controla cuánto pueden diferir.
5. *(Opcional)* Activa **Roles** en Ajustes para evitar que un equipo junte 3+
   jugadores del mismo rol.

## Probarlo ya (modo demo)

Abre `balanceador-unite.html` en el navegador y pulsa **Cargar ejemplo** →
**Buscar y balancear**. En modo demo las estadísticas se generan localmente
(estables por nombre), así ves el balanceo sin montar nada.

## Datos reales en local (Node 18+)

```bash
npm install
node server.js
```

El servidor sirve **la página y la API juntas** en `http://localhost:3000`:
- `/` → la página del balanceador
- `GET /api/player/:usuario` → datos de un jugador
- `POST /api/players` con `{ "usuarios": ["a","b"] }` → en lote
- `GET /api/health` → estado

Abre `http://localhost:3000`, ve a **Ajustes ⚙** y apaga *Modo demo*. Como la
página la sirve el propio backend, **no hace falta pegar ninguna URL**: usa el
mismo origen automáticamente.

## Desplegar gratis (un solo servicio sirve web + API)

Este proyecto incluye `render.yaml`, así que el deploy en
[Render](https://render.com) (plan gratis) es de un clic:

1. Sube este repo a GitHub (si no lo está).
2. En Render: **Dashboard → New → Blueprint → conecta el repo → Apply**.
   Render detecta `render.yaml`, instala (`npm install`) y arranca
   (`node server.js`).
3. Cuando termine, abre la URL que te da Render
   (ej. `https://balanceador-unite.onrender.com`).
4. En la página → **Ajustes ⚙** → apaga *Modo demo*. Ya funciona con datos
   reales (mismo origen, sin configurar nada más).

> El plan gratis de Render "duerme" el servicio tras inactividad; la primera
> petición tras dormir tarda unos segundos en despertar.

**Alternativas gratis** (mismo `startCommand: node server.js`, `PORT` lo pone el
host): Railway, Fly.io, Cyclic, Glitch. Si prefieres separar, puedes hospedar el
HTML aparte (GitHub Pages / Netlify) y en *Ajustes* pegar la URL del backend.

## Notas

- UniteAPI renderiza los datos en el HTML; `server.js` los parsea con
  expresiones regulares tolerantes. Si la web cambia su maquetación, ajusta los
  patrones en `parsePlayerHtml()`.
- El backend cachea cada perfil 5 minutos para no saturar la fuente.
- Los pesos del cálculo de nivel (`RANK_BASE`, ajuste de win%, bono de
  experiencia) están al principio del `<script>` del HTML por si quieres
  afinarlos a tu grupo.

## Variables de entorno (backend)

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `UNITE_BASE` | `https://uniteapi.dev` | Origen de los datos |
