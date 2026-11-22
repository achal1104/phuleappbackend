import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Catch, ArgumentsHost, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

@Catch()
class AllErrors implements ExceptionFilter {
  private log = new Logger('Errors');
  catch(e: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof HttpException) { const r: any = e.getResponse(); return res.status(e.getStatus()).json({ statusCode: e.getStatus(), message: r.message ?? e.message }); }
    this.log.error(e?.stack || e);
    res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}

async function bootstrap() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET (>=32 chars) is required');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.use(helmet());
  app.enableCors({ origin: (process.env.CORS_ORIGINS || '*').split(','), credentials: true });
  app.useGlobalFilters(new AllErrors());
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.getHttpAdapter().getInstance().get('/health', (_q: any, r: any) => r.json({ ok: true }));
  await app.listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
bootstrap();
