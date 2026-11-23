-- Orçamento global diário de chamadas da LLM — issue #35.
--
-- Uma linha por dia UTC (`day`) com a cota já consumida (`calls`). A reserva é
-- `INSERT ... ON CONFLICT ("day") DO UPDATE ... WHERE calls < teto RETURNING`
-- (ver `src/search/prisma-daily-llm-budget.repository.ts`): a decisão de caber ou
-- não no orçamento sai de uma instrução atômica no banco, senão dois processos
-- em paralelo gastariam o dobro do teto.
--
-- `day` é a chave primária porque o orçamento é exatamente "um número por dia":
-- uma linha por chamada seria um log que cresce sem servir a nenhuma leitura.

-- CreateTable
CREATE TABLE "llm_daily_budget" (
    "day" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "llm_daily_budget_pkey" PRIMARY KEY ("day")
);
