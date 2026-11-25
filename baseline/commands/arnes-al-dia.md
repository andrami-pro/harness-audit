---
description: Pone el arnés de este proyecto al día con el baseline común (reglas de bloqueo, gate en verde, auditoría de prompts, CI)
---

Pon este repositorio al día con el baseline de arnés común a todos tus proyectos.

La versión vigente está en `~/.claude/harness-baseline/VERSION` y lo que incluye, en `~/.claude/harness-baseline/CHANGELOG.md`; léelos primero. Lo que es igual para todos los proyectos ya vive a nivel usuario, para Claude Code (reglas de bloqueo en `~/.claude/settings.json`, hook Stop `~/.claude/hooks/verify-on-stop.sh`, CLAUDE.md y skills globales) y para Pi (extensión `~/.pi/agent/extensions/harness-baseline.ts`, que usa la misma lista y los mismos scripts): no lo copies al repo salvo lo que se indica abajo. Este archivo sirve de comando en las dos herramientas.

Trabaja sobre lo que el repo necesita, en este orden, y salta lo que ya esté hecho:

1. **Reglas de bloqueo commiteadas.** Fusiona la lista de `~/.claude/harness-baseline/deny.json` en `permissions.deny` del `.claude/settings.json` del repo (créalo si no existe; no borres nada que ya tenga). Si el repo tiene otros archivos de secretos (por ejemplo `service-account.json`, `*.pem`, `.npmrc` con token), añádelos y dilo. Son las reglas que una sesión en la nube lleva consigo.

2. **Gate en verde.** El hook Stop ejecuta `.claude/verify.sh` si es ejecutable y, si no, el script `preflight` del `package.json`.
   - Si el repo no tiene ninguno, propone un `.claude/verify.sh` con sus comprobaciones rápidas (lint, typecheck, tests unitarios; que tarde menos de un minuto) y créalo cuando el usuario lo apruebe.
   - Ejecuta el gate una vez a través del hook, para que quede registrado el verde: `echo '{"cwd":"'"$PWD"'"}' | ~/.claude/hooks/verify-on-stop.sh`. Antes, lee el script del gate: si hace algo más que comprobar (migraciones, deploy, llamadas de red con efectos), no lo ejecutes y pregunta.
   - Si sale en rojo, encuentra la causa. Arregla lo que sea de configuración del gate (por ejemplo, lint que revisa carpetas de herramientas); un fallo real de código preséntalo al usuario en vez de taparlo.

3. **Auditoría de prompts de la configuración del proyecto.** Solo en Claude Code, que trae el skill `claude-api`; en Pi, deja este paso como pendiente y dile al usuario que lo corra desde Claude Code. Ejecuta el subcomando `prompt-audit` del skill `claude-api` con este alcance: `CLAUDE.md`, `CLAUDE.local.md` y `AGENTS.md` del repo, y lo que haya en `.claude/agents/`, `.claude/skills/`, `.claude/commands/` y `.claude/rules/`. La configuración de nivel usuario ya se auditó el 2026-11-13: déjala fuera. Presenta el informe y el diff; aplica solo los cambios que el usuario acepte.

4. **CI.** Comprueba si `.github/workflows/` ejecuta el mismo gate en cada PR. Si no, propón el workflow; no lo empujes.

5. **Sello.** Cuando 1 y 2 estén hechos (o el usuario decida dejarlos pendientes), escribe la versión de `~/.claude/harness-baseline/VERSION` en `.claude/harness-baseline`. Termina con una lista corta: qué quedó hecho, qué quedó pendiente y por qué.

No hagas commit ni push salvo que el usuario lo pida.
