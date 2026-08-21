# Nota Fiscal Mineira — recomendações de modelo e relatório

## Resultado da análise

O modelo já disponibiliza os fatos centrais para adesão, notas fiscais, bilhetagem,
premiações, indicações e requisições. Não era necessário alterar tabelas físicas,
mas eram necessários ajustes no YAML para que o relatório não produzisse chaves
ambíguas e pudesse navegar entre requisição, prêmio e status de pagamento.

Os seguintes ajustes foram aplicados no modelo:

- `tf_qt_nfce_dia.id` passou a identificar município e data de emissão; somente o
  município não é chave única para um fato diário.
- `tf_quantidade_bilhetes_participante` passou a expor a quantidade de bilhetes
  também como dimensão. Isso viabiliza o histograma exato solicitado, sem carregar
  a lista inteira de participantes no navegador.
- As duas fatos de requisição agora se relacionam ao status de retorno de
  pagamento. A fato de requisição de entidade também se relaciona à premiação da
  entidade; a de participante ganhou o calendário de requisição.
- A dimensão de município se relaciona à região fiscal e a dimensão de sorteio à
  bilhetagem, tornando os filtros e rótulos geográficos reutilizáveis.
- Foram criadas dimensões de papel para município e região fiscal de participante
  e de entidade. Elas eliminam a ambiguidade da fato de indicações, que possui
  duas chaves para cada localização.

## Pontos que precisam de confirmação no banco

| Prioridade | Ponto | Impacto no relatório | Ação recomendada |
| --- | --- | --- | --- |
| Alta | Chave única de `TF_REQUISICAO_PAGAMENTO_ENTIDADE` | A tabela não expõe o sequencial da requisição. A chave composta atual reduz colisões, mas não as prova impossíveis. | Confirmar a chave física e expô-la como dimensão `primary_key`. |
| Alta | Localidade da entidade | `TD_ENTIDADE_SOCIAL.ID_LOCALIDADE` não permite inferir com segurança que corresponde a `TD_MUNICIPIO.SK_MUNICIPIO` ou a `ID_MUNICIPIO_SIARE`. | Confirmar a chave de referência e criar o join. Até isso, “entidades cadastradas por município/região” deve ser entendido como entidades indicadas/premiadas, não cadastro completo. |
| Alta | Emitente de documento fiscal | `TF_NOTAS_PARTICIPANTE_DIA` não contém CNPJ nem nome do emitente. | Criar uma fato no grão participante × emitente × dia, ou acrescentar a chave do emitente e uma dimensão de emitente. Sem isso, a página do participante não pode detalhar documentos por emitente. |
| Alta | Abrangência do sorteio | Não há atributo semântico explícito de abrangência na fato de premiação. O tipo de sorteio é apenas uma aproximação. | Expor `abrangencia_sorteio` na dimensão de sorteio, com valores municipal, regional e estadual. |
| Média | Histórico de adesão | `TF_PARTICIPANTE_ADESAO` é um retrato diário. Consultas de “situação atual” precisam sempre fixar a maior data disponível. | Manter este comportamento no frontend e, se recorrente, criar uma medida/visão de “último retrato”. |
| Média | População | Somar população após juntar fatos diários multiplica o valor por dia. | Consultar população diretamente da dimensão de município/região e combiná-la no cliente pelo identificador geográfico. |
| Média | Desempenho | Os fatos diários e a adesão por retrato serão as consultas mais custosas. | Criar pré-agregações por dia × município, dia × região fiscal e data de adesão; particionar por data e atualizar incrementalmente. |
| Baixa | Nomenclatura | Há títulos com erros de digitação e mistura de abreviações técnicas. | Padronizar títulos em português e ocultar chaves substitutas nas visualizações finais. |

## Regras de consulta adotadas

- O intervalo padrão do relatório é de 04/08/2024 até hoje. Cada visualização usa
  sua própria dimensão de tempo, portanto o filtro global não transforma uma data
  de sorteio em data de requisição, nem o contrário.
- A quantidade de participantes ativos e impedidos é calculada sobre a data máxima
  de `TF_PARTICIPANTE_ADESAO`, independentemente do fim do intervalo global.
- Para evitar consulta gargalo, cada card, gráfico ou tabela é carregado de modo
  independente e registra no modal de diagnóstico a latência e o número de linhas.
- Valores de população são apresentados abreviados somente na interface; a
  exportação mantém o valor numérico integral.

## Evoluções de visualização sugeridas

- Mapa coroplético municipal com alternância entre adesão, NFC-e NFM por mil
  habitantes e evolução recente. Deve ser incluído somente após validar geometrias
  do município e a chave de localidade.
- Funil de premiação: sorteado → requisitado → retornado → pago, com tempo médio
  entre etapas. Requer a confirmação da chave única de requisição.
- Coortes de adesão por mês de entrada, mostrando retenção de participantes ativos
  ao longo dos meses.
- Heatmap dia da semana × hora para NFC-e, caso a origem passe a disponibilizar a
  hora de emissão.
- Boxplot e percentis de bilhetes por participante por tipo de sorteio. É uma
  evolução mais legível que faixas fixas quando houver pré-agregações adequadas.
- Árvore de indicações por região e município, com filtro de entidade, usando as
  dimensões de papel criadas para a fato de indicações.

