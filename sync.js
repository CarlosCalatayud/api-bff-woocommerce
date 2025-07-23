// sync.js - VERSIÓN FINAL Y PROFESIONAL
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const { z } = require('zod');
const pino = require('pino');
const util = require('util');

const logger = pino({ level: 'info' });

// --- 1. CONFIGURACIÓN DE CLIENTES ---
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const wooApi = new WooCommerceRestApi({
    url: process.env.WOOCOMMERCE_STORE_URL,
    consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
    consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
    version: 'wc/v3',
});

// --- 2. VALIDACIÓN Y TRANSFORMACIÓN ---
const ProductSchema = z.object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    type: z.enum(['simple', 'variable', 'bundle', 'variation', 'grouped', 'external']),
    status: z.string(),
    description: z.string().default(''),
    short_description: z.string().default(''),
    sku: z.string().min(1, { message: "SKU no puede estar vacío." }),
    price: z.string(),
    regular_price: z.string().nullable().default('0'),
    sale_price: z.string().nullable().default('0'),
    on_sale: z.boolean(),
    stock_quantity: z.number().int().nullable(),
    stock_status: z.enum(['instock', 'outofstock', 'onbackorder']),
    manage_stock: z.boolean(),
    date_modified_gmt: z.string(),
});

function transformWooProduct(productData) {
    const validatedData = ProductSchema.parse(productData);
    
    return {
        wc_product_id: validatedData.id,
        name: validatedData.name,
        slug: validatedData.slug,
        type: validatedData.type,
        status: validatedData.status,
        is_active: validatedData.status === 'publish',
        description: validatedData.description,
        short_description: validatedData.short_description,
        sku: validatedData.sku,
        regular_price: parseFloat(validatedData.regular_price) || 0,
        sale_price: parseFloat(validatedData.sale_price) || 0,
        price: parseFloat(validatedData.price) || 0,
        on_sale: validatedData.on_sale,
        stock_quantity: validatedData.stock_quantity,
        stock_status: validatedData.stock_status,
        manage_stock: validatedData.manage_stock,
        wc_modified_at_gmt: new Date(validatedData.date_modified_gmt).toISOString(),
    };
}

// --- 3. LÓGICA PRINCIPAL DE SINCRONIZACIÓN ---
async function syncAllProducts() {
    logger.info('Iniciando sincronización masiva de productos...');
    
    let page = 1;
    const perPage = 50;
    let productsProcessed = 0;
    let totalProducts = 0;
    let continueSyncing = true;

    while (continueSyncing) {
        let productsFromApi;
        try {
            logger.info(`Obteniendo página ${page} de productos de WooCommerce...`);
            const response = await wooApi.get('products', {
                per_page: perPage,
                page: page,
            });

            if (page === 1 && response.headers['x-wp-total']) {
                totalProducts = parseInt(response.headers['x-wp-total'], 10);
                logger.info(`Total de productos encontrados en WooCommerce: ${totalProducts}`);
            }
            
            productsFromApi = response.data;

            if (!Array.isArray(productsFromApi) || productsFromApi.length === 0) {
                logger.info('No hay más productos para sincronizar. Finalizando bucle.');
                continueSyncing = false;
                continue;
            }

        } catch (error) {
            logger.fatal('FALLO CRÍTICO: No se pudo obtener la lista de productos de WooCommerce.');
            if (error && error.response) {
                logger.fatal({
                    status: error.response.status,
                    data: error.response.data,
                }, 'Detalles del error de la API de WooCommerce:');
            } else {
                const fullErrorObject = util.inspect(error, { depth: 5 });
                logger.fatal({ errorObject: fullErrorObject }, 'Inspección completa del error:');
            }
            continueSyncing = false;
            continue;
        }

        const productsToUpsert = [];
        logger.info(`Procesando lote de ${productsFromApi.length} productos...`);

        for (const product of productsFromApi) {
            try {
                const transformed = transformWooProduct(product);
                productsToUpsert.push(transformed);
            } catch (error) {
                if (error instanceof z.ZodError) {
                    const skuError = error.errors.find(e => e.path.includes('sku'));
                    if (skuError) {
                        logger.warn({ wc_product_id: product.id, name: product.name }, `PRODUCTO IGNORADO: Falta SKU.`);
                    } else {
                        logger.error({ wc_product_id: product.id, name: product.name, error: error.flatten() }, 'Error de validación de Zod. Saltando producto.');
                    }
                } else {
                    logger.error({ wc_product_id: product.id, name: product.name, message: error.message }, 'Error inesperado al transformar producto. Saltando producto.');
                }
            }
        }

        if (productsToUpsert.length > 0) {
            try {
                logger.info(`Enviando ${productsToUpsert.length} productos válidos a Supabase...`);
                const { error: upsertError } = await supabase
                    .from('products')
                    .upsert(productsToUpsert, { onConflict: 'wc_product_id' });

                if (upsertError) {
                    logger.error({ code: upsertError.code, message: upsertError.message, details: upsertError.details }, 'Error al hacer upsert en Supabase. El lote no se guardó.');
                } else {
                    productsProcessed += productsToUpsert.length;
                    logger.info(`Lote guardado con éxito. Total procesado: ${productsProcessed} de ${totalProducts}`);
                }
            } catch (dbError) {
                logger.fatal({ message: dbError.message }, 'FALLO CRÍTICO: Error de conexión con la base de datos.');
                continueSyncing = false;
            }
        } else {
            logger.warn('Ningún producto en este lote era válido para ser enviado a Supabase.');
        }

        page++;
    }

    logger.info('Sincronización masiva completada.');
}

// --- Ejecución ---
syncAllProducts().catch(err => {
    logger.fatal({ error: util.inspect(err, {depth: 5}) }, "Ha ocurrido un error no capturado en la ejecución principal.");
});