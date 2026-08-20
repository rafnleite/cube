# Multi-datamart Cube development

This fork keeps semantic models physically and logically isolated:

```
datamarts/<datamart-id>/
  datamart.json      # name and connection preset id; never credentials
  model/
    cubes/*.yml
    views/*.yml
```

Connection presets live in `config/connections.json`. Copy
`config/connections.example.json` and edit only non-secret metadata and field
definitions. Credentials are supplied on each datamart-open operation and are
held only as AES-256-GCM encrypted values in the backend session store. The
encryption key comes from `CUBEJS_DATAMART_SESSION_SECRET`.

Each field can declare `driverOption` to map the form value directly to the
selected Cube driver constructor. Secret fields are forbidden in `defaults`.

The intended API namespace is `/cubejs-api/datamarts/:datamartId/v1`. The datamart
id must also be used by `contextToAppId`, `contextToOrchestratorId`, and
`repositoryFactory`, so compiler caches, orchestrators, filters, and models do
not cross datamart boundaries.

## Development container

1. Copy `.env.multi-datamart.example` to `.env.multi-datamart` and replace the key.
2. Copy `config/connections.example.json` to `config/connections.json`.
3. Run `docker compose -f compose.dev.yml build` while network access is open.
4. Export the built image before moving to a restricted computer:
   `docker save cube-core-cube-dev -o cube-core-dev.tar`.
5. On the restricted computer run `docker load -i cube-core-dev.tar`, then use
   Compose without rebuilding.

The image contains Node, Yarn, Rust, Cargo, C/C++ build tools, protobuf,
unixODBC development headers, and the Node `odbc` native module.

## Run

Use `docker compose -f compose.dev.yml up` or the equivalent
`podman compose -f compose.dev.yml up --no-build`, then open
`http://localhost:4000`. `--no-build` is useful on the restricted computer
after importing `cube-core-dev:latest` with `podman load`.
Compose compiles the local bind-mounted source before starting the development
server, so edits remain on the host and a restart picks them up.

The Node ODBC binding is installed and verified. An actual Cube ODBC driver is
still a separate implementation; selecting the example ODBC preset returns an
explicit error until that driver exists.
