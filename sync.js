require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const { z } = require('zod');
const pino = require('pino');

const logger = pino({ level: 'info' });

// --- 1. CONFIGURACIÓN DE CLIENTES ---

// Cliente de Supabase (usando la clave de servicio para tener control total)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Cliente de la API de WooCommerce
const wooApi = new WooCommerceRestApi({
    url: process.env.WOOCOMMERCE_STORE_URL,
    consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
    consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
    version: 'wc/v3',
});

// --- 2. VALIDACIÓN Y TRANSFORMACIÓN ---

// Reutilizamos el schema de Zod de nuestro servidor para consistencia
const ProductSchema = z.object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    type: z.enum(['simple', 'variable', 'bundle', 'variation', 'grouped']), // 'grouped' es otro tipo común
    status: z.string(),
    description: z.string().optional(),
    short_description: z.string().optional(),
    sku: z.string().optional().nullable(),
    price: z.string(),
    regular_price: z.string().optional().nullable(),
    sale_price: z.string().optional().nullable(),
    on_sale: z.boolean(),
    stock_quantity: z.number().int().nullable(),
    stock_status: z.enum(['instock', 'outofstock', 'onbackorder']),
    manage_stock: z.boolean(),
    date_modified_gmt: z.string(),

});

function transformWooProduct(productData) {
    // Validamos los datos entrantes de WooCommerce
    const validatedData = ProductSchema.parse(productData);
    
    // Devolvemos el objeto listo para insertar en Supabase
    return {
        wc_product_id: validatedData.id,
        name: validatedData.name,
        slug: validatedData.slug,
        type: validatedData.type,
        status: validatedData.status,
        is_active: validatedData.status === 'publish',
        description: validatedData.description || '',
        short_description: validatedData.short_description || '',
        sku: validatedData.sku || '',
        regular_price: parseFloat(validatedData.regular_price) || 0,
        sale_price: parseFloat(validatedData.sale_price) || 0,
        price: parseFloat(validatedData.price) || 0,
        on_sale: validatedData.on_sale,
        stock_quantity: validatedData.stock_quantity,
        stock_status: validatedData.stock_status,
        manage_stock: validatedData.manage_stock,
        wc_modified_at_gmt: new Date(validatedData.date_modified_gmt).toISOString(),

        // ... completa con cualquier otro campo que necesites
    };
}


// --- 3. LÓGICA PRINCIPAL DE SINCRONIZACIÓN ---

async function syncAllProducts() {
    logger.info('Iniciando sincronización masiva de productos...');
    
    let page = 1;
    const perPage = 50; // Productos por página, 50 es un buen número. No uses más de 100.
    let productsProcessed = 0;
    let totalProducts = 0; // Lo obtendremos de la cabecera de la primera respuesta

    try {
        do {
            logger.info(`Obteniendo página ${page} de productos...`);
            
            const response = await wooApi.get('products', {
                per_page: perPage,
                page: page,
            });
            
            if (page === 1) {
                totalProducts = parseInt(response.headers['x-wp-total'], 10);
                logger.info(`Total de productos a sincronizar: ${totalProducts}`);
            }

            const products = response.data;
            if (products.length === 0) {
                logger.info('No hay más productos para sincronizar.');
                break;
            }

            const productsToUpsert = [];
            for (const product of products) {
                try {
                    const transformed = transformWooProduct(product);
                    productsToUpsert.push(transformed);
                } catch (error) {
                    logger.error({ wc_product_id: product.id, error: error.message }, 'Error al transformar producto. Saltando...');
                }
            }
            
            if (productsToUpsert.length > 0) {
                const { error: upsertError } = await supabase
                    .from('products')
                    .upsert(productsToUpsert, { onConflict: 'wc_product_id' });

                if (upsertError) {
                    logger.error({ error: upsertError }, 'Error al hacer upsert en Supabase.');
                    // Decidimos no parar el script, pero logueamos el error grave.
                } else {
                    productsProcessed += productsToUpsert.length;
                    logger.info(`Lote de ${productsToUpsert.length} productos procesado. Total: ${productsProcessed}/${totalProducts}`);
                }
            }

            page++;

        } while (true);

    } catch (error) {
        logger.fatal({ error: error.message, stack: error.stack }, 'Error fatal durante la sincronización masiva.');
    }

    logger.info('Sincronización masiva completada.');
}

// Ejecutar la función
syncAllProducts();