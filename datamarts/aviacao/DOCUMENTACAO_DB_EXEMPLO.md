# Auditoria e recomendações do datamart de aviação

## Escopo e método

Esta auditoria foi refeita em **17/08/2026**, partindo dos YAMLs atualmente
carregados pelo datamart `aviacao`, da estrutura real do PostgreSQL local e da
documentação oficial do banco de demonstração Airlines do Postgres Pro.

Fontes oficiais consultadas:

- [Visão geral do banco Airlines](https://postgrespro.com/docs/postgrespro/current/demodb-bookings)
- [Objetos do schema](https://postgrespro.com/docs/postgrespro/current/demodb-schema-objects)
- [Consultas e uso](https://postgrespro.com/docs/postgrespro/current/demodb-usage)
- [Diagrama oficial do schema](https://postgrespro.com/docs/postgrespro/current/demodb-schema-diagram)

Também foram executadas consultas de cardinalidade, integridade referencial e
unicidade no banco, além de consultas equivalentes pela API do Cube. O banco
local informa:

```text
bookings.version(): PostgresPro 2025-09-01 (730 days)
bookings.now():     2027-09-01 00:00:00+00
```

Como esse banco usa um instante lógico próprio, consultas que dependem da data
de referência devem usar `bookings.now()`, e não o relógio da máquina que
executa os testes.

## Inventário atual

O datamart possui oito arquivos YAML e nove cubos:

| Arquivo | Cubos | Fonte |
| --- | --- | --- |
| `airplanes.yml` | `airplanes` | `bookings.airplanes` |
| `airports.yml` | `airports_arrival`, `airports_departure` | `bookings.airports` |
| `boarding_passes.yml` | `boarding_passes` | `bookings.boarding_passes` |
| `bookings.yml` | `bookings` | `bookings.bookings` |
| `seats.yml` | `seats` | `bookings.seats` |
| `segments.yml` | `segments` | `bookings.segments` |
| `tickets.yml` | `tickets` | `bookings.tickets` |
| `timetable.yml` | `timetable` | `bookings.timetable` |

Os dois cubos de aeroporto são cubos de papel sobre a mesma view. Isso é
correto: a mesma entidade participa dos voos como aeroporto de chegada e como
aeroporto de saída.

Os joins atualmente modelados são:

| Origem | Destino | Relação | Chave |
| --- | --- | --- | --- |
| `segments` | `boarding_passes` | 1:1 | `ticket_no + flight_id` |
| `segments` | `timetable` | N:1 | `flight_id` |
| `segments` | `tickets` | N:1 | `ticket_no` |
| `tickets` | `bookings` | N:1 | `book_ref` |
| `timetable` | `airplanes` | N:1 | `airplane_code` |
| `timetable` | `airports_arrival` | N:1 | `arrival_airport` |
| `timetable` | `airports_departure` | N:1 | `departure_airport` |
| `seats` | `airplanes` | N:1 | `airplane_code` |

## O que está consistente

Estas decisões já estão alinhadas com a fonte e não devem reaparecer como
recomendações pendentes:

- `segments` e `boarding_passes` usam uma identificação calculada baseada em
  `ticket_no` e `flight_id`.
- O join entre segmentos e cartões de embarque compara os dois componentes da
  chave composta; comparar somente `flight_id` seria incorreto.
- `segments.total_price` e `segments.avg_price` agregam `segments.price`.
- `bookings.total_amount` usa a coluna física correta `total_amount`.
- `tickets -> bookings`, `segments -> tickets`, `segments -> timetable`,
  `seats -> airplanes` e os três papéis de `timetable` têm cardinalidade
  compatível com o modelo atual.
- `range` e `speed` são atributos descritivos de aeronaves e permanecem
  corretamente como dimensões. Medidas de média ou máximo só devem ser criadas
  se houver um indicador de negócio explícito.
- Não é necessário criar uma medida para cada status de voo. Filtrar
  `timetable.status` é mais flexível; medidas como `delayed_count` só fazem
  sentido como KPIs padronizados e recorrentes.
- As hierarquias dos aeroportos usam diretamente `country`, `city` e
  `airport_code`. `airport_name` permanece disponível como atributo
  descritivo, sem participar da sequência hierárquica.
- A view `bookings.timetable` é adequada para o modelo atual porque já aplica
  a validade temporal da rota antes de expor os dados do voo.

As consultas de integridade executadas retornaram zero referências inválidas
para segmentos sem ticket, segmentos sem registro correspondente em
`timetable`, cartões sem segmento e assentos sem aeronave. No snapshot atual,
`timetable` possui 135.571 linhas, 135.571 `flight_id` distintos e 135.571
combinações distintas de `(route_no, scheduled_departure)`.

## Ajustes ainda necessários nos YAMLs

### 1. Corrigir o tipo de `timetable.flight_id`

Em `timetable.yml`, `flight_id` está declarado como `type: string`, mas a view
`bookings.timetable` retorna `integer` para `flight_id`.
O tipo deve ser alterado para:

```yaml
- title: ID do voo
  name: flight_id
  sql: flight_id
  type: number
```

Essa divergência afeta filtros, comparação de chaves e a consistência da API.

### 2. Corrigir o título de `scheduled_departure`

Em `timetable.yml`, `scheduled_departure` está com o título “Horário partida
UTC real”. O campo é o horário agendado, não o horário real. Usar, por
exemplo:

```yaml
title: Horário de partida UTC agendado
```

`actual_departure` é o campo correspondente ao horário real.

### 3. Formalizar a decisão da chave de `timetable`

Hoje `timetable.id` é uma dimensão calculada e marcada como chave primária,
formada por `flight_id` e `scheduled_departure`. Essa escolha é aceitável para
uma view, pois a constraint da tabela subjacente não é propagada para o Cube.

No snapshot atual, a view tem 135.571 linhas, 135.571 `flight_id` distintos e
135.571 combinações distintas de `(route_no, scheduled_departure)`. Isso
comprova a unicidade neste banco, mas não substitui uma decisão explícita para
futuras cargas:

- manter `id` como chave técnica do Cube e testar sua unicidade a cada carga;
  ou
- promover `flight_id` a chave primária do Cube se o contrato do datamart for
  sempre “uma linha por voo” e o compilador aceitar essa chave na view.

Não remover `id` automaticamente apenas porque os joins atuais usam
`flight_id`. O Cube precisa de uma chave primária semântica para validar
determinadas relações e agregações.

### 4. Decidir a visibilidade das colunas técnicas de join

`flight_id` e `ticket_no` em `segments` e `boarding_passes` são componentes de
chaves físicas e de joins. Eles não devem ser removidos do SQL do modelo. Se o
objetivo da interface for não oferecê-los como dimensões de negócio, a opção
mais segura é mantê-los como dimensões técnicas ocultas (`shown: false`),
preservando a capacidade de filtrar e auditar as relações quando necessário.

Essa decisão deve ser aplicada de maneira uniforme: a coluna usada em um join
composto continua representada na chave composta; se também participar de um
join individual, o modelo pode manter a linha técnica individual desse join.

## Melhorias opcionais, condicionadas ao escopo analítico

### Pré-agregações

Nenhum YAML atual declara `pre_aggregations`. Isso não é erro funcional, mas
significa que as consultas passam pelo caminho detalhado. Depois de definir os
dashboards e seus filtros mais frequentes, avaliar pré-agregações por grão:

- reservas, para `bookings.total_amount`;
- segmentos, para `segments.price` e seus agregados;
- voo/status/tempo, para painéis de operação.

Não pré-agregar `bookings.total_amount` em um grão de segmentos: o join 1:N
repetiria o total da reserva e poderia inflar a soma.

### Validação de assentos embarcados

O schema garante que o cartão pertence ao segmento, mas não garante que
`boarding_passes.seat_no` exista na configuração de assentos do avião que
opera o voo. Se essa regra fizer parte do produto, criar uma view ou rotina de
qualidade que valide:

```text
boarding_passes.flight_id
  -> timetable.airplane_code
  -> seats.airplane_code + seats.seat_no
```

Essa validação não deve ser transformada em um join semântico obrigatório sem
antes tratar as inconsistências encontradas.

## Testes automatizados de paridade

O arquivo
`datamarts/aviacao/tests/aviacao-query-parity.test.cjs` contém uma suíte
executável com o runner nativo do Node. Ela abre uma sessão do datamart,
consulta a API do Cube e executa a consulta SQL equivalente diretamente no
PostgreSQL, normalizando tipos numéricos e temporais antes da comparação.

Casos cobertos:

- inventário dos nove cubos e metadados das hierarquias;
- auditoria de tipo e título do modelo;
- medidas `count`, `sum` e `avg` em reservas;
- filtro temporal;
- join `tickets -> bookings`;
- joins `segments -> timetable -> airports_arrival/airports_departure`;
- filtro por medida com granularidade mensal;
- join composto `segments -> boarding_passes`;
- join `seats -> airplanes`;
- integridade referencial das chaves usadas pelos joins.

Execução padrão:

```text
node --test datamarts/aviacao/tests/aviacao-query-parity.test.cjs
```

Por padrão, a suíte executa as comparações e imprime as pendências de contrato
do modelo sem interromper os testes de paridade. Para transformar essas
pendências em falhas bloqueantes:

```powershell
$env:CUBE_AVIACAO_STRICT_MODEL = '1'
node --test datamarts/aviacao/tests/aviacao-query-parity.test.cjs
```

As credenciais e endereços usados localmente têm valores padrão compatíveis
com o ambiente de desenvolvimento. Eles podem ser substituídos por:
`CUBE_TEST_API_URL`, `CUBE_TEST_API_DB_HOST`, `CUBE_TEST_DB_HOST`,
`CUBE_TEST_DB_PORT`, `CUBE_TEST_DB_NAME`, `CUBE_TEST_DB_USER` e
`CUBE_TEST_DB_PASSWORD`.

## Ordem recomendada de execução

1. Corrigir o tipo de `timetable.flight_id` e o título de
   `scheduled_departure`.
2. Executar a suíte de paridade no modo padrão e depois no modo estrito.
3. Formalizar a política de visibilidade das chaves técnicas.
4. Decidir, com base nos painéis reais, se são necessárias pré-agregações e a
   validação de assentos.

Depois de cada alteração estrutural, executar novamente a suíte e validar o
modelo completo:

```text
cubejs validate -p datamarts/aviacao/model
```
