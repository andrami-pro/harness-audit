# Baseline de arnés — qué trae cada versión

Cada proyecto guarda en `.claude/harness-baseline` la versión que tiene aplicada. Al abrirlo, el hook
`~/.claude/hooks/baseline-check.sh` compara con `VERSION` y, si está atrasado, avisa y ofrece `/arnes-al-dia`.
Para mejorar todos los proyectos: cambia `/arnes-al-dia` (o `deny.json`), añade una entrada aquí y sube `VERSION`.

La fuente de estos archivos es la carpeta `baseline/` del repositorio harness-audit. Se editan allí y
`baseline/install.sh` los copia a `~/.claude` y `~/.pi`; un cambio hecho directamente en la copia se pierde en la
siguiente instalación (`baseline/install.sh --check` lo detecta antes).

## Cambios de nivel usuario (no suben la versión: ningún proyecto tiene que hacer nada)
- 2026-11-25: `verify-on-stop.sh` registra cada ejecución del gate en `~/.claude/gate-log.ndjson`;
  `baseline/gate-stats.js` cuenta, por proyecto, cuántas regresiones atrapó el gate.

## 2026.11.13
- Reglas de bloqueo commiteadas en `.claude/settings.json` (lista en `deny.json`), para que viajen a sesiones en la nube.
- Un gate de verificación en verde (`.claude/verify.sh` o el script `preflight`) que el hook Stop global pueda ejecutar.
- Auditoría de prompts de la configuración del proyecto (CLAUDE.md, AGENTS.md, agentes, skills, comandos) contra el modelo actual.
- CI que ejecute el mismo gate en cada PR (se informa si falta).
- Pi recibe lo mismo con la extensión `~/.pi/agent/extensions/harness-baseline.ts` (bloqueo de secretos y force push, aviso de baseline, verificación al terminar) y el comando `/arnes-al-dia` como prompt template (enlace a `~/.claude/commands/arnes-al-dia.md`).
