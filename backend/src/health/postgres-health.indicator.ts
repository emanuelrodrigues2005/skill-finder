import { Injectable } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';

import { PrismaService } from '../prisma/prisma.service';

// Arquivo próprio (e não dentro de `health.module.ts`) para o controller poder
// injetá-lo sem um import circular entre os dois arquivos.
@Injectable()
export class PostgresHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async check(key = 'postgres'): Promise<HealthIndicatorResult> {
    const reachable = await this.prisma.ping();
    return this.getStatus(key, reachable, { dependency: 'postgres' });
  }
}
