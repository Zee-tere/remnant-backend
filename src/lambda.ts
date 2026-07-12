import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Handler, Context, Callback } from 'aws-lambda';
import helmet from 'helmet';
import { configure as serverlessExpress } from '@vendia/serverless-express';
import { AppModule } from './app.module';
import { isAllowedOrigin, parseOriginList } from './config/origin';

let server: Handler;

async function bootstrap(): Promise<Handler> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const isProduction = process.env.NODE_ENV === 'production';
  const allowedOrigins = parseOriginList(
    process.env.FRONTEND_URL,
    process.env.ALLOWED_ORIGINS,
    ...(isProduction ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']),
  );

  app.enableCors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin, allowedOrigins, { allowPrivateLan: !isProduction })) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  await app.init();

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
    return { statusCode: 200, body: 'warm' };
  }

  context.callbackWaitsForEmptyEventLoop = false;
  server = server ?? (await bootstrap());
  return server(event, context, callback);
};
