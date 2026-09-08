import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { mkdirSync } from 'fs';
import { AppModule } from './app.module';
import {
  avatarUploadDir,
  eventImageUploadDir,
  publicationCoverUploadDir,
} from './uploads';
import { csrfOriginProtection } from './security/csrf-origin';
import { trustedProxy } from './security/security-request-context';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', trustedProxy);
  const uploads = avatarUploadDir();
  mkdirSync(uploads, { recursive: true });
  app.useStaticAssets(uploads, {
    prefix: '/uploads/avatars',
    fallthrough: false,
    index: false,
  });
  const eventImages = eventImageUploadDir();
  mkdirSync(eventImages, { recursive: true });
  app.useStaticAssets(eventImages, {
    prefix: '/uploads/event-images',
    fallthrough: false,
    index: false,
  });
  const publicationCovers = publicationCoverUploadDir();
  mkdirSync(publicationCovers, { recursive: true });
  app.useStaticAssets(publicationCovers, {
    prefix: '/uploads/publication-covers',
    fallthrough: false,
    index: false,
  });
  app.use(cookieParser());
  app.use(csrfOriginProtection);
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

bootstrap();
