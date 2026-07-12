import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { isAllowedOrigin, parseOriginList } from './config/origin';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security headers for XSS, clickjacking, MIME sniffing, etc.
  app.use(helmet());

  // Enable global validation.
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

  await app.listen(process.env.PORT ?? 3001, '0.0.0.0');
  console.log(`[App] Running on port ${process.env.PORT ?? 3001}`);
}
bootstrap();
