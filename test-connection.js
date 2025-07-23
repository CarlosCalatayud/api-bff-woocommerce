require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const pino = require('pino');
const util = require('util');

const logger = pino({ level: 'info' });

async function testConnections() {
    logger.info('--- INICIANDO PRUEBA DE CONEXIONES ---');

    // --- Prueba 1: Conexión con WooCommerce ---
    try {
        logger.info('Intentando conectar con WooCommerce...');
        const wooApi = new WooCommerceRestApi({
            url: process.env.WOOCOMMERCE_STORE_URL,
            consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
            consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
            version: 'wc/v3',
        });

        // Hacemos una petición simple que debería funcionar siempre
        const response = await wooApi.get('');
        logger.info({ wooCommerceResponse: response.data }, '✅ Conexión con WooCommerce EXITOSA.');

    } catch (error) {
        logger.fatal('❌ FALLO en la conexión con WooCommerce.');
        const fullErrorObject = util.inspect(error, { depth: 5 });
        logger.fatal({ errorObject: fullErrorObject }, 'Detalles del error de WooCommerce:');
    }

    logger.info('--- ------------------- ---');

    // --- Prueba 2: Conexión con Supabase ---
    try {
        logger.info('Intentando conectar con Supabase...');
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );

        // Hacemos una petición simple a una tabla (incluso si está vacía)
        // Reemplaza 'products' si la tabla se llama diferente, pero debería ser esa.
        const { data, error } = await supabase
            .from('products')
            .select('id')
            .limit(1);

        if (error) {
            // Esto es un error devuelto por la API de Supabase, no una excepción
            throw error;
        }

        logger.info('✅ Conexión con Supabase EXITOSA.');
        
    } catch (error) {
        logger.fatal('❌ FALLO en la conexión con Supabase.');
        const fullErrorObject = util.inspect(error, { depth: 5 });
        logger.fatal({ errorObject: fullErrorObject }, 'Detalles del error de Supabase:');
    }

    logger.info('--- PRUEBA DE CONEXIONES FINALIZADA ---');
}

testConnections();