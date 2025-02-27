import * as Sentry from '@sentry/node';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from 'aws-lambda';
import { TypedError } from 'typed-error';

const { SENTRY_DSN, VERSION } = process.env;

let sentryInitialized = false;
export function initSentry() {
    if (SENTRY_DSN) {
        Sentry.init({ dsn: SENTRY_DSN, release: VERSION });
        sentryInitialized = true;
        console.log("Sentry initialized");
    } else {
        console.log("No Sentry DSN available, error reporting disabled");
    }
}

interface Auth0RequestError extends Error {
    // See https://github.com/auth0/node-auth0/blob/master/src/errors.js
    statusCode: number | string | undefined,
    requestInfo: { method?: string, url?: string },
    originalError: Error
};

export class StatusError extends TypedError {
    constructor(
        public readonly statusCode: number,
        message: string
    ) {
        super(message);
    }
}

export async function reportError(error: Error | Auth0RequestError | string, eventContext?: APIGatewayProxyEvent) {
    if (error instanceof Error && 'requestInfo' in error) {
        console.warn(`${
            error.requestInfo.method
        } request to ${
            error.requestInfo.url
        } failed with status ${error.statusCode}: ${error.message}`);

        console.warn(error.originalError);
    } else {
        console.warn(error);
    }

    if (!sentryInitialized) return;

    Sentry.withScope((scope) => {
        scope.addEventProcessor((event) => {
            if (eventContext) {
                const request = event.request || {};
                request.method = request.method || eventContext.httpMethod;
                request.url = request.url || eventContext.path;
                request.headers = request.headers || eventContext.headers;
                event.request = request;
            }

            if (error instanceof Error && 'originalError' in error) {
                event.extra = Object.assign(event.extra || {}, {
                    originalName: error.originalError.name,
                    originalMessage: error.originalError.message,
                    originalStack: error.originalError.stack
                });
            }

            return event;
        });

        if (typeof error === 'string') {
            Sentry.captureMessage(error);
        } else {
            Sentry.captureException(error);
        }
    });

    // Cast required temporarily - this is new in 4.6.0, and isn't in
    // the typings quite yet.
    await Sentry.flush();
}

type ApiHandler = Handler<APIGatewayProxyEvent, APIGatewayProxyResult>;

export function catchErrors(handler: ApiHandler): ApiHandler {
    return async function (this: any, event, context) {
        // Make sure AWS doesn't wait for an empty event loop, as that
        // can break things with Sentry
        context.callbackWaitsForEmptyEventLoop = false;
        try {
            return await (handler.call as any)(this, ...arguments);
        } catch (e: any) {
            // Catches sync errors & promise rejections, because we're async
            await reportError(e, event);

            if (e instanceof StatusError) {
                return {
                    statusCode: e.statusCode,
                    headers: { 'Cache-Control': 'no-store' },
                    body: e.message
                }
            } else {
                throw e;
            }
        }
    };
}