# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) ·
versionado [SemVer](https://semver.org/lang/es/).

## [0.2.0] — 2026-11-25

Primera versión instalable como plugin de DSH. Mismo runtime que 0.1.0, con el
empaquetado cambiado.

### Añadido

- `dsh.bundle.patch` en `package.json` y `cordis.patch.yml` con la entrada
  `memory`. Esto es lo que convierte el paquete en *bundle*: el gestor de
  plugins del perfil lo añade a `dsh.profile.bundles` y compone su capa, en vez
  de instalarlo como dependencia plana inactiva.
- `peerDependencies` de los paquetes DSH que el host debe aportar
  (`@deepseek-ai/dsh-tools`, `dsh-llm`, `schemastery`, `cordis`), declaradas
  opcionales. Con specs git la comprobación de compatibilidad es posterior a la
  instalación, así que declararlas es lo que la hace explícita.
- `engines.node >= 22.19.0`, `license`, `files`, `.gitignore`, `LICENSE` y este
  CHANGELOG.

### Cambiado

- `private: true` eliminado: un paquete privado no se puede publicar ni tratar
  como capa de perfil.
- `mongodb` pasa de `dependencies` a `devDependencies`. El driver no se usa en
  runtime: viaja vendido en `lib/mongodb.bundle.cjs`. Así el `pnpm add` del
  gestor no instala nada y no hay script de build que pnpm tenga que aprobar.

### Sin cambios

- Cero `prepare`/`postinstall` a propósito: pnpm 11 bloquea los scripts de build
  de dependencias git, y el gestor de DSH se queda en `pendingBuilds` esperando
  aprobación.
- Lógica de captura, recall, puntuación, backend y datos. La colección
  `dsh_memory.memories` es la misma: instalar el bundle no toca los datos.

## [0.1.0] — 2026-11-19

- Versión inicial: captura de turnos, recall híbrido (`$vectorSearch` + `$text`
  + recencia), tools `memory_search` / `memory_save` / `memory_forget` /
  `memory_stats`, aprovisionamiento automático de Atlas Local o `mongod` local,
  driver de MongoDB vendido como bundle CJS.
