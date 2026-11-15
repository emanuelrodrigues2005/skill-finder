import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { PostgresHealthIndicator } from './postgres-health.indicator';

/**
 * `TerminusModule` é quem registra o `HealthCheckService` injetado pelo
 * controller: sem este import o Nest não resolve a dependência e o processo não
 * sobe. Os indicators continuam providers locais (o controller não monta nada a
 * mão). `PrismaModule` é `@Global`, então o indicator resolve `PrismaService`.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [PostgresHealthIndicator],
})
export class HealthModule {}
