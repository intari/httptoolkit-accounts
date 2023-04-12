import * as _ from 'lodash';
import * as crypto from 'crypto';
import * as net from 'net';
import fetch from 'node-fetch';
import moment, { Moment } from 'moment';
import stoppable from 'stoppable';

import { expect } from 'chai';

import {
    startServer,
    auth0Server,
    AUTH0_PORT,
    givenUser,
    givenNoUsers,
    PAYPRO_IPN_VALIDATION_KEY
} from './test-util';
import { PayProOrderDateFormat, PayProRenewalDateFormat, PayProWebhookData } from '../src/paypro';

// Validated by testing with the real key and signatures from real IPN
// requests - this generates the correct matching signature.
const getSignature = (body: Partial<PayProWebhookData>) => {
    const key = [
        body.ORDER_ID,
        body.ORDER_STATUS,
        body.ORDER_TOTAL_AMOUNT,
        body.CUSTOMER_EMAIL,
        PAYPRO_IPN_VALIDATION_KEY,
        body.TEST_MODE,
        body.IPN_TYPE_NAME
    ].join('');

    return crypto.createHash('sha256')
        .update(key)
        .digest('hex');
}

const getPayProWebhookData = (unsignedBody: Partial<PayProWebhookData>) => {
    const body = {
        SIGNATURE: getSignature(unsignedBody),
        ...unsignedBody
    } as PayProWebhookData;

    return {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(
            body as unknown as { [key: string]: string }
        ).toString()
    };
}

const triggerWebhook = async (
    server: net.Server,
    unsignedBody: Partial<PayProWebhookData>,
    options: { expectedStatus: number } = { expectedStatus: 200 }
) => {
    const functionServerUrl = `http://localhost:${(server.address() as net.AddressInfo).port}`;

    const result = await fetch(
        `${functionServerUrl}/.netlify/functions/paypro-webhook`,
        getPayProWebhookData(unsignedBody)
    );

    expect(result.status).to.equal(options.expectedStatus);
}

function formatOrderDate(date: Moment) {
    return date.utc().format(PayProOrderDateFormat);
}

// Yes these two dates are different, and yes this one is especially nuts
function formatRenewalDate(date: Moment) {
    return date.utc().format(PayProRenewalDateFormat);
}

describe('PayPro webhooks', () => {

    let functionServer: stoppable.StoppableServer;

    beforeEach(async () => {
        functionServer = await startServer();
        await auth0Server.start(AUTH0_PORT);
        await auth0Server.forPost('/oauth/token').thenReply(200);
    });

    afterEach(async () => {
        await new Promise((resolve) => functionServer.stop(resolve));
        await auth0Server.stop();
    });

    it('should reject invalid webhooks', async () => {
        const auth0ApiMock = await auth0Server
            .forAnyRequest()
            .always()
            .asPriority(100)
            .thenReply(200);


        await triggerWebhook(functionServer, {
            IPN_TYPE_NAME: 'OrderCharged',
            ORDER_ITEM_SKU: 'pro-monthly',
            CUSTOMER_ID: '123',
            SUBSCRIPTION_ID: '456',
            SUBSCRIPTION_RENEWAL_TYPE: 'Auto',
            SUBSCRIPTION_NEXT_CHARGE_DATE: formatRenewalDate(moment('2025-01-01')),
            ORDER_PLACED_TIME_UTC: formatOrderDate(moment()),
            PRODUCT_QUANTITY: '1',
            TEST_MODE: '0',
            CUSTOMER_EMAIL: 'test@email.com',

            SIGNATURE: 'BAD-SIGNATURE'
        }, {
            // Should loudly fail:
            expectedStatus: 403
        });

        // Should not do anything with user data:
        const authRequests = await auth0ApiMock.getSeenRequests();
        expect(authRequests.length).to.equal(0);
    });

    describe("for Pro subscriptions", () => {

        it('successfully handle new subscriptions for an existing user', async () => {
            const userId = "abc";
            const userEmail = 'user@example.com';
            givenUser(userId, userEmail);

            const userUpdate = await auth0Server
                .forPatch('/api/v2/users/' + userId)
                .thenReply(200);

            const nextRenewal = moment('2025-01-01');

            await triggerWebhook(functionServer, {
                IPN_TYPE_NAME: 'OrderCharged',
                ORDER_ITEM_SKU: 'pro-monthly',
                CUSTOMER_ID: '123',
                SUBSCRIPTION_ID: '456',
                SUBSCRIPTION_RENEWAL_TYPE: 'Auto',
                SUBSCRIPTION_NEXT_CHARGE_DATE: formatRenewalDate(nextRenewal),
                ORDER_PLACED_TIME_UTC: formatOrderDate(moment()),
                PRODUCT_QUANTITY: '1',
                TEST_MODE: '0',
                CUSTOMER_EMAIL: userEmail
            });

            const updateRequests = await userUpdate.getSeenRequests();
            expect(updateRequests.length).to.equal(1);
            expect(await updateRequests[0].body.getJson()).to.deep.equal({
                app_metadata: {
                    subscription_status: 'active',
                    payment_provider: 'paypro',
                    subscription_id: '456',
                    subscription_sku: 'pro-monthly',
                    subscription_quantity: 1,
                    subscription_expiry: nextRenewal.valueOf()
                }
            });
        });

    });
});