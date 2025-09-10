// sync.js - VERSIÓN ULTRA-ROBUSTA SIN ZOD
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const pino = require('pino');

const logger = pino({ level: 'info' });

// --- CONFIGURACIÓN ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const wooApi = new WooCommerceRestApi({
    url: process.env.WOOCOMMERCE_STORE_URL,
    consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
    consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
    version: 'wc/v3',
    timeout: 30000,
});

// --- LÓGICA DE SINCRONIZACIÓN ---
async function syncAllData() {
    logger.info('--- Iniciando Sincronización Masiva ---');

    // 1. Sincronizar Categorías
    logger.info('Sincronizando categorías...');
    let page = 1;
    const allCategories = [];
    while (true) {
        const response = await wooApi.get('products/categories', { per_page: 100, page });
        if (!response.data || response.data.length === 0) break;
        allCategories.push(...response.data);
        page++;
    }
    const categoriesToUpsert = allCategories.map(cat => ({
        wc_category_id: cat.id, name: cat.name, slug: cat.slug,
        description: cat.description || '', image_url: cat.image ? cat.image.src : null,
    }));
    if (categoriesToUpsert.length > 0) {
        await supabase.from('categories').upsert(categoriesToUpsert, { onConflict: 'wc_category_id' });
    }
    logger.info(`✅ ${allCategories.length} categorías sincronizadas.`);
    const { data: localCategories } = await supabase.from('categories').select('id, wc_category_id');
    const wcCategoryIdToUuidMap = new Map(localCategories.map(c => [c.wc_category_id, c.id]));

    // 2. Sincronizar Productos
    logger.info('Sincronizando productos y relaciones...');
    page = 1;
    let productsProcessed = 0;
    let totalProducts = 0;

    while (true) {
        logger.info(`Obteniendo página ${page} de productos...`);
        const response = await wooApi.get('products', { per_page: 50, page });
        if (page === 1) totalProducts = parseInt(response.headers['x-wp-total'], 10);
        
        const productsFromApi = response.data;
        if (!Array.isArray(productsFromApi) || productsFromApi.length === 0) break;

        const productsToUpsert = [];
        const imagesToUpsert = [];
        const categoryMapsToUpsert = [];

        for (const product of productsFromApi) {
            if (!product.sku || product.sku.trim().length === 0) {
                logger.warn({ wc_product_id: product.id, name: product.name }, `PRODUCTO IGNORADO: Falta SKU.`);
                continue;
            }

            productsToUpsert.push({
                wc_product_id: product.id, name: product.name, slug: product.slug,
                type: product.type || 'simple', status: product.status, is_active: product.status === 'publish',
                description: product.description || '', short_description: product.short_description || '',
                sku: product.sku, price: parseFloat(product.price || 0),
                regular_price: parseFloat(product.regular_price || 0),
                sale_price: parseFloat(product.sale_price || 0),
                on_sale: product.on_sale || false,
                stock_quantity: product.stock_quantity === null ? null : Number(product.stock_quantity) || null,
                stock_status: product.stock_status || 'outofstock',
                manage_stock: product.manage_stock || false,
                wc_modified_at_gmt: new Date(product.date_modified_gmt).toISOString(),
            });

            if (Array.isArray(product.images)) {
                for (const image of product.images) {
                    if (image && typeof image.id === 'number') {
                        imagesToUpsert.push({
                            wc_image_id: image.id, product_wc_id: product.id,
                            src_url: image.src, alt_text: image.alt || '', position: image.position || 0
                        });
                    }
                }
            }
            
            if (Array.isArray(product.categories)) {
                for (const category of product.categories) {
                    if (wcCategoryIdToUuidMap.has(category.id)) {
                        categoryMapsToUpsert.push({
                            product_wc_id: product.id,
                            category_id: wcCategoryIdToUuidMap.get(category.id)
                        });
                    }
                }
            }
        }

        if (productsToUpsert.length > 0) {
            const { data: insertedProducts, error: productError } = await supabase
                .from('products').upsert(productsToUpsert, { onConflict: 'wc_product_id' }).select('id, wc_product_id');
            
            if (productError) {
                logger.error({ error: productError }, 'Error al hacer upsert de productos.');
            } else {
                productsProcessed += productsToUpsert.length;
                logger.info(`Lote de productos guardado. Total procesado: ${productsProcessed} de ${totalProducts}`);
                
                const wcProductIdToUuidMap = new Map(insertedProducts.map(p => [p.wc_product_id, p.id]));
                
                const finalImages = imagesToUpsert.filter(img => wcProductIdToUuidMap.has(img.product_wc_id)).map(img => ({
                    ...img, product_id: wcProductIdToUuidMap.get(img.product_wc_id)
                }));
                if (finalImages.length > 0) await supabase.from('product_images').upsert(finalImages, { onConflict: 'wc_image_id' });

                const finalCategoryMaps = categoryMapsToUpsert.filter(map => wcProductIdToUuidMap.has(map.product_wc_id)).map(map => ({
                    product_id: wcProductIdToUuidMap.get(map.product_wc_id), category_id: map.category_id
                }));
                if (finalCategoryMaps.length > 0) await supabase.from('product_categories_map').upsert(finalCategoryMaps);
            }
        } else {
            logger.warn('Ningún producto en este lote era válido.');
        }
        page++;
    }
}

// --- FUNCIÓN PRINCIPAL DE EJECUCIÓN ---
async function main() {
    try {
        await syncAllData();
        logger.info('✅ Sincronización masiva completada con éxito.');
    } catch (error) {
        logger.fatal({ error: error.message, stack: error.stack }, 'La sincronización masiva ha fallado.');
        process.exit(1);
    }
}

main();