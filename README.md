# Troll Wars V0.5.6 — Guest Server UI Fix

Guest Server now works with both direct index.html mode and server mode.

- Direct index.html: Solo Play works locally.
- Create Server from direct mode automatically opens `http://localhost:3000/?guest=create`.
- Join Server from direct mode automatically opens `http://localhost:3000/?guest=join&id=XXXXXX`.
- Server mode creates/joins temporary Guest Servers by 6-character ID.

For shared Guest Servers, run `npm install` then `npm start` and open `http://localhost:3000`.


## V0.5.6 Combat Update
- Directional melee attacks with a 110° hit arc.
- Server-authoritative facing and hit detection.
- Attack cone visual feedback.
- Player facing indicator.
- Existing Guest Server, bombs, destruction, EXP, deaths and graves preserved.
