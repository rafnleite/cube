# Documentação do banco de exemplo de aviação

## Escopo

Esta documentação descreve o banco de demonstração Airlines do PostgreSQL Pro
e o modelo semântico atualmente configurado em `projects/aviacao/model`.

O banco local usado pelo projeto é o `demo`, no schema `bookings`. A versão
local pode ser conferida com:

```sql
SELECT bookings.version();
```

O resultado registrado anteriormente foi:

```text
PostgresPro 2025-09-01 (730 days)
```

As quantidades e datas podem ser diferentes dos exemplos publicados. O banco é
uma fotografia de dados; em análises que dependem do momento lógico do demo,
prefira `bookings.now()` a `CURRENT_TIMESTAMP`.

## Modelo semântico atual

Os cubos atualmente disponíveis são:

- `bookings`;
- `tickets`;
- `segments`;
- `boarding_passes`;
- `timetable`;
- `airplanes`;
- `airports_departure`;
- `airports_arrival`;
- `seats`.

Não existem cubos `flights` ou `routes` neste modelo. As tabelas
`bookings.flights` e `bookings.routes` continuam existindo no banco, mas são
consultadas indiretamente pela view `bookings.timetable`.

O cubo `timetable` é a principal interface para análises de voos e rotas. Ele
já disponibiliza `flight_id`, `route_no`, aeroportos de partida e chegada,
status e horários UTC e locais.

## Objetos do banco

### Tabelas

O banco possui, entre outras, as tabelas:

`bookings.bookings`, `bookings.tickets`, `bookings.segments`,
`bookings.boarding_passes`, `bookings.flights`, `bookings.routes`,
`bookings.seats`, `bookings.airplanes_data` e `bookings.airports_data`.

A existência dessas tabelas não significa que todas devam virar cubos. As
tabelas `flights` e `routes`, por exemplo, já são consolidadas pela view usada
no cubo `timetable`.

### Views

- `bookings.airplanes`: transforma o modelo JSONB de `airplanes_data` em dados
  de aviões conforme o idioma atual.
- `bookings.airports`: transforma os nomes, cidades e países armazenados em
  JSONB em colunas utilizáveis.
- `bookings.timetable`: combina voos, rotas e aeroportos e calcula os horários
  locais.

Os cubos devem continuar apontando para essas views quando elas forem a fonte
do modelo. Não trocar as views pelas tabelas `_data` sem revisar o formato das
colunas.

Documentação consultada:

- [Visão geral do banco de demonstração](https://postgrespro.com/community/demodb)
- [Objetos do schema](https://postgrespro.com/docs/postgrespro/current/demodb-schema-objects)
- [Uso e consultas de exemplo](https://postgrespro.com/docs/postgrespro/current/demodb-usage)

## Regras importantes do banco

- Uma reserva pode ter vários bilhetes.
- Cada bilhete pode ter vários segmentos.
- Cada segmento representa um trecho de voo.
- Uma rota liga um aeroporto de partida a um aeroporto de chegada.
- A mesma `route_no` pode aparecer em períodos diferentes de validade.
- A chave natural de um voo é composta por `route_no` e
  `scheduled_departure`; a tabela também possui `flight_id`.
- `bookings.total_amount` representa o valor total dos bilhetes de uma
  reserva.

As regras de validade temporal entre voos e rotas já são tratadas pela view
`timetable`. Por isso, o modelo atual não precisa manter um join semântico
entre cubos de voos e rotas.

## Ajustes recomendados

### Cubo `bookings`

Corrigir o nome público da medida, caso ainda esteja incorreto:

```text
total_amoun -> total_amount
```

Medidas recomendadas:

- `total_amount`: soma de `total_amount`;
- `average_booking_amount`: média de `total_amount`;
- `count`: quantidade de reservas.

Como uma reserva pode ter vários bilhetes e segmentos, o valor de
`total_amount` pode ser repetido em joins. Para indicadores financeiros,
prefira consultas no nível de `bookings` ou uma pré-agregação nesse nível.

### Cubo `timetable`

Este é o cubo que deve ser usado para as análises de voos e rotas.

Recomendações:

- alterar `flight_id` para o tipo numérico do banco;
- manter uma chave primária compatível com a granularidade da view;
- manter `route_no`, `departure_airport` e `arrival_airport` como dimensões;
- usar os campos com sufixo `_local` para análises no horário local;
- manter os campos UTC para integrações e comparações técnicas.

Medidas possíveis:

- `count`: quantidade de voos;
- `delayed_count`: voos com status `Delayed`;
- `cancelled_count`: voos com status `Cancelled`;
- `arrived_count`: voos com status `Arrived`.

Não adicionar um join para `flights` ou `routes`: esses cubos não fazem parte
do modelo atual e a view já fornece as informações necessárias.

### Cubo `segments`

Alterar o tipo da dimensão `price` de `string` para `number`.

Medidas recomendadas:

- `total_price`: soma de `price`;
- `average_price`: média de `price`;
- `count`: quantidade de segmentos.

### Cubo `airplanes`

A view também possui `range` e `speed`. Se forem necessários nas análises,
adicioná-los como dimensões numéricas.

### Cubo `boarding_passes`

Adicionar, se necessário:

- `flight_id`;
- `boarding_no`.

O relacionamento com `segments` deve considerar a chave composta
`(ticket_no, flight_id)`.

## Relacionamentos atuais

Os relacionamentos do modelo devem seguir esta estrutura:

- `bookings` → `tickets`: um para muitos;
- `tickets` → `segments`: um para muitos;
- `segments` → `boarding_passes`: um para um;
- `segments` → `timetable`: muitos para um;
- `timetable` → `airplanes`: muitos para um;
- `timetable` → `airports_arrival`: muitos para um;
- `airports_departure` → `timetable`: um para muitos;
- `airplanes` → `seats`: um para muitos.

O modelo atual não possui o relacionamento `flights` → `routes`, pois os dois
cubos foram removidos.

## Dimensões e hierarquias

### Datas

Configurar granularidades ano, trimestre, mês, dia e hora para:

- `bookings.book_date`;
- `timetable.scheduled_departure`;
- `timetable.actual_departure`;
- `timetable.scheduled_arrival`;
- `timetable.actual_arrival`.

Uma hierarquia útil é:

```text
Ano > Trimestre > Mês > Dia
```

### Localização

Nos cubos de aeroportos, usar:

```text
País > Cidade > Aeroporto
```

As coordenadas podem permanecer como `geo`, com latitude e longitude
definidas separadamente.

### Voos e rotas

Como `timetable` já consolida os dados, tratar estas informações como
dimensões relacionadas, não como cubos independentes:

```text
Aeroporto de partida | Rota | Aeroporto de chegada
```

Exemplo de análise:

```text
Aeroporto de partida | Aeroporto de chegada | Quantidade de voos
CNF                  | GRU                  | 125
```

O campo `route_no` identifica a rota na view, mas não deve ser tratado como
chave primária isolada das tabelas brutas.

## Pontos de atenção

1. A view `timetable` usa `INNER JOIN`. Um voo sem rota válida ou sem
   aeroportos correspondentes não aparece nessa view.
2. A view simplifica o relacionamento temporal entre voos e rotas, mas pode
   ser mais pesada por também consultar os aeroportos.
3. `routes.days_of_week` é um array de inteiros e não está exposto pelo cubo
   `timetable` atual. Para analisar dias específicos, será necessário criar
   uma view auxiliar ou reintroduzir um modelo específico para esse caso.
4. Não há pré-agregações configuradas. Para os primeiros testes isso é
   aceitável; dashboards maiores podem precisar de pré-agregações.
5. O arquivo `model/views/example_view.yml` está totalmente comentado e não
   participa do modelo.
6. O arquivo `model/.cube-diagram.json` ainda pode conter referências antigas
   a `cubes/flights.yml` e `cubes/routes.yml`. Ele deve ser regenerado ou
   limpo para que o diagrama represente apenas os cubos atuais.
7. O nome do cubo é `timetable`, no singular. Um erro sobre
   `Cube timetables doesn't exist` indica referência antiga ou incorreta.

## Ordem sugerida para os testes

1. Validar o cubo `bookings` e corrigir o nome `total_amount`.
2. Testar `bookings` com `tickets`, depois `segments` e `boarding_passes`.
3. Testar `timetable` usando as datas UTC e locais.
4. Testar aeroportos de partida e chegada separadamente.
5. Adicionar as medidas recomendadas depois que os relacionamentos básicos
   estiverem funcionando.

Após qualquer alteração no modelo, executar:

```text
cubejs validate -p projects/aviacao/model
```
