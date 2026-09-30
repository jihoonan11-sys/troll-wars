# Troll Wars: Continent of Ruins — V0.6.0

## New architecture

- GitHub = source code
- GitHub Pages = game client
- Node.js + Socket.io = multiplayer server
- Database/Storage = next development stage

## GitHub Pages

The repository root contains `index.html`, so GitHub Pages can publish the game directly.

Expected URL:

`https://jihoonan11-sys.github.io/troll-wars/`

GitHub Pages only serves the client. It does not run `server.js`.

## Multiplayer server

Deploy this repository to a Node.js host that supports WebSockets.

After deployment, edit the following line in `index.html`:

`window.TROLL_WARS_SERVER_URL = "https://YOUR-SERVER-URL";`

Then push the change to GitHub.

The server has a health endpoint:

`/health`

Guest Server IDs are currently in-memory. Persistent server storage will be added in the next development stage.

## Local test

1. Install Node.js.
2. Run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000`.
5. Create a Guest Server and use its 6-character ID on another browser/device connected to the same public server.

## Current controls

- WASD = Move
- SPACE = Attack
- B = Bomb

## Development direction

1. GitHub Pages + server connection
2. Guest Server ID
3. Persistent server storage
4. Account data
5. Admin Panel
6. Staff content tools
7. Custom Server
