import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Handler, Context, Callback } from 'aws-lambda';
import helmet from 'helmet';
import { configure as serverlessExpress } from '@vendia/serverless-express';
import { AppModule } from './app.module';
import { isAllowedOrigin, parseOriginList } from './config/origin';
import { INestApplication } from '@nestjs/common';
import { OutboxRelayService } from './outbox/outbox-relay.service';
import { MatchingJobsService } from './matching/matching-jobs.service';
import { MatchingService } from './matching/matching.service';
import { UploadService } from './upload/upload.service';
import { UserService } from './user/user.service';
import { ListingsService } from './listings/listings.service';
import { requestContext } from './config/request-context';

let server: Handler;
let nestApp: INestApplication;

async function bootstrapApp(): Promise<INestApplication> {
  if (nestApp) return nestApp;
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    rawBody: true,
  });

  app.use(helmet());
  app.use('/auth', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const isProduction =
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  const allowedOrigins = parseOriginList(
    process.env.FRONTEND_URL,
    process.env.ALLOWED_ORIGINS,
    ...(isProduction ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']),
  );

  app.use(requestContext(allowedOrigins, !isProduction));
  app.enableCors({
    origin: (origin, callback) => {
      if (
        isAllowedOrigin(origin, allowedOrigins, {
          allowPrivateLan: !isProduction,
        })
      ) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Guest-Token',
      'X-Request-ID',
    ],
    exposedHeaders: ['X-Request-ID'],
    credentials: true,
  });

  await app.init();
  nestApp = app;
  return app;
}

async function bootstrap(): Promise<Handler> {
  const app = await bootstrapApp();
  return serverlessExpress({
    app: app.getHttpAdapter().getInstance(),
  });
}

export const handler: Handler = async (
  event: any,
  context: Context,
  callback: Callback,
) => {
  if (event.source === 'aws.events' && event['detail-type'] === 'KeepWarm') {
    const app = await bootstrapApp();
    const matching = await app.get(MatchingJobsService).processPending(10);
    return { statusCode: 200, body: JSON.stringify({ warm: true, matching }) };
  }

  if (
    event.source === 'aws.events' &&
    event['detail-type'] === 'RemnantOutboxRelay'
  ) {
    const app = await bootstrapApp();
    const [outbox, matching] = await Promise.all([
      app.get(OutboxRelayService).relayPending(),
      app.get(MatchingJobsService).processPending(10),
    ]);
    return { outbox, matching };
  }

  if (
    event.source === 'aws.events' &&
    event['detail-type'] === 'RemnantMatchingWorker'
  ) {
    const app = await bootstrapApp();
    return app.get(MatchingJobsService).processPending(25);
  }

  if (
    event.source === 'aws.events' &&
    event['detail-type'] === 'RemnantMaintenance'
  ) {
    const app = await bootstrapApp();
    const [queued, uploads, deletions, listings] = await Promise.all([
      app.get(MatchingService).runDailyBackfill(),
      app.get(UploadService).cleanupPendingUploads(),
      app.get(UserService).purgeExpiredDeletionRequests(),
      app.get(ListingsService).expireListings(),
    ]);
    const processed = await app.get(MatchingJobsService).processPending(25);
    return { ...queued, processed, uploads, deletions, listings };
  }

  context.callbackWaitsForEmptyEventLoop = false;
  server = server ?? (await bootstrap());
  return server(event, context, callback);
};
