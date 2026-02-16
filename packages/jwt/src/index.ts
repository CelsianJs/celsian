// @celsian/jwt — JWT authentication plugin

import * as jose from 'jose';
import type { PluginFunction, HookHandler, CelsianRequest, CelsianReply } from '@celsian/core';

export interface JWTOptions {
  secret: string;
  algorithms?: string[];
}

export interface JWTPayload {
  [key: string]: unknown;
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
}

export interface JWTNamespace {
  sign(payload: JWTPayload, options?: { expiresIn?: string | number }): Promise<string>;
  verify(token: string): Promise<JWTPayload>;
}

export function jwt(options: JWTOptions): PluginFunction {
  const algorithms = options.algorithms ?? ['HS256'];
  const secretKey = new TextEncoder().encode(options.secret);

  return function jwtPlugin(app) {
    const jwtInstance: JWTNamespace = {
      async sign(payload: JWTPayload, signOptions?: { expiresIn?: string | number }): Promise<string> {
        let builder = new jose.SignJWT(payload as jose.JWTPayload)
          .setProtectedHeader({ alg: algorithms[0]! })
          .setIssuedAt();

        if (signOptions?.expiresIn) {
          if (typeof signOptions.expiresIn === 'number') {
            builder = builder.setExpirationTime(Math.floor(Date.now() / 1000) + signOptions.expiresIn);
          } else {
            builder = builder.setExpirationTime(signOptions.expiresIn);
          }
        }

        return builder.sign(secretKey);
      },

      async verify(token: string): Promise<JWTPayload> {
        const { payload } = await jose.jwtVerify(token, secretKey, {
          algorithms,
        });
        return payload as JWTPayload;
      },
    };

    app.decorate('jwt', jwtInstance);
  };
}

export function createJWTGuard(options: JWTOptions): HookHandler {
  const algorithms = options.algorithms ?? ['HS256'];
  const secretKey = new TextEncoder().encode(options.secret);

  const guard: HookHandler<void | Response> = async (request: CelsianRequest, reply: CelsianReply) => {
    const auth = request.headers.get('authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = auth.slice(7);

    try {
      const { payload } = await jose.jwtVerify(token, secretKey, { algorithms });
      (request as Record<string, unknown>).user = payload;
    } catch {
      return reply.status(401).json({ error: 'Invalid or expired token' });
    }
  };

  return guard as HookHandler;
}
