import { RequestMethod, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppConfig } from './config/config';
import { csrfProtection } from './common/csrf.middleware';

/** Security and request settings shared by the real server and the tests. */
export function configureApp(app: NestExpressApplication) {
  const config = app.get(AppConfig);

  // Behind the OpenShift router and the web proxy: take the client IP from X-Forwarded-For.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '10kb' });
  app.use(csrfProtection(config.appOrigins));

  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, stopAtFirstError: true }),
  );
  app.enableShutdownHooks();
  return app;
}
