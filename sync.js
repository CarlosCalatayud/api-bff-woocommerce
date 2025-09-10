// sync.js - VERSIÓN FINAL Y A PRUEBA DE BALAS
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
    timeout: 30000,
});

// --- 2. SCHEMAS DE VALIDACIÓN (ZOD) ---
// Este es un schema simple para los datos YA LIMPIOS
const CleanProductSchema = z.object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    type: z.string(),
    status: z.string(),
    description: z.string(),
    short_description: z.string(),
    sku: z.string(), // La validación de no-vacío se hace manualmente
    price: z.string(),
    regular_price: z.string(),
    sale_price: z.string(),
    on_sale: z.boolean(),
    stock_quantity: z.number().int().nullable(),
    stock_status: z.enum(['instock', 'outofstock', 'onbackorder']),
    manage_stock: z.boolean(),
    date_modified_gmt: z.string(),
    categories: z.array(z.object({ id: z.number() })),
    images: z.array(z.object({
        id: z.number(),
        src: z.string().url(),
        alt: z.string(),
        position: z.number()
    })),
    attributes: z.array(z.any()),
});


// --- 3. FUNCIONES DE SINCRONIZACIÓN ---
async function syncCategories() {
    logger.info('--- Iniciando sincronización de CATEGORÍAS ---');
    let page = 1;
    const allCategories = [];
    while (true) {
        const response = await wooApi.get('products/categories', { per_page: 100, page });
        const categories = response.data;
        if (!categories || categories.length === 0) break;
        allCategories.push(...categories);
        page++;
    }
    const categoriesToUpsert = allCategories.map(cat => ({
        wc_category_id: cat.id, name: cat.name, slug: cat.slug,
        description: cat.description || '', image_url: cat.image ? cat.image.src : null,
    }));
    if (categoriesToUpsert.length > 0) {
        const { error } = await supabase.from('categories').upsert(categoriesToUpsert, { onConflict: 'wc_category_id' });
        if (error) { logger.error({ error }, 'Error al sincronizar categorías.'); throw error; }
    }
    logger.info(`✅ ${allCategories.length} categorías sincronizadas.`);
}


async function syncAllProducts() {
    logger.info('--- Iniciando sincronización de PRODUCTOS y sus relaciones ---');
    
    const { data: localCategories, error: catError } = await supabase.from('categories').select('id, wc_category_id');
    if(catError) throw catError;
    const wcCategoryIdToUuidMap = new Map(localCategories.map(c => [c.wc_category_id, c.id]));

    let page = 1;
    const perPage = 50;
    let productsProcessed = 0;
    let totalProducts = 0;
    let continueSyncing = true;

    while (continueSyncing) {
        let productsFromApi;
        try {
            logger.info(`Obteniendo página ${page} de productos de WooCommerce...`);
            const response = await wooApi.get('products', { per_page: perPage, page });
            if (page === 1 && response.headers['x-wp-total']) {
                totalProducts = parseInt(response.headers['x-wp-total'], 10);
            }
            logger.info(`Página ${page} obtenida. Total de productos: ${totalProducts}`);
            productsFromApi = response.data;
            if (!Array.isArray(productsFromApi) || productsFromApi.length === 0) {
                continueSyncing = false; continue;
            }
        } catch (error) {
            logger.fatal('FALLO CRÍTICO al obtener productos de WooCommerce.', { error: util.inspect(error, { depth: 5 }) });
            continueSyncing = false; continue;
        }

        const productsToUpsert = [];
        const imagesToUpsert = [];
        const categoryMapsToUpsert = [];

        logger.info(`Procesando lote de ${productsFromApi.length} productos...`);

        for (const product of productsFromApi) {
            // 1. VALIDACIÓN MANUAL DE REGLAS DE NEGOCIO
            if (!product.sku || product.sku.trim().length === 0) {
                logger.warn({ wc_product_id: product.id, name: product.name }, `PRODUCTO IGNORADO: Falta SKU.`);
                continue; // Salta al siguiente producto
            }

            // 2. LIMPIEZA MANUAL Y EXPLÍCITA DE DATOS
            const cleanProduct = {
                ...product,
                images: Array.isArray(product.images) ? product.images.filter(img => img && typeof img.id === 'number') : [],
                categories: Array.isArray(product.categories) ? product.categories : [],
                description: product.description || '',
                short_description: product.short_description || '',
                price: String(product.price || '0'),
                regular_price: String(product.regular_price || '0'),
                sale_price: String(product.sale_price || '0'),
                stock_quantity: product.stock_quantity === null ? null : Number(product.stock_quantity) || null,
                type: product.type || 'simple',
                alt: product.alt || ''
            };

            // 3. VALIDACIÓN SEGURA DEL OBJETO LIMPIO
            const validationResult = CleanProductSchema.safeParse(cleanProduct);

            if (!validationResult.success) {
                logger.warn({ wc_product_id: product.id, name: product.name, error: validationResult.error.flatten().fieldErrors }, `PRODUCTO IGNORADO por error de validación tras limpieza.`);
                continue;
            }
            
            const validatedData = validationResult.data;

            // 4. TRANSFORMACIÓN FINAL (si todo es correcto)
            productsToUpsert.push({
                wc_product_id: validatedData.id,
                name: validatedData.name, slug: validatedData.slug, type: validatedData.type,
                status: validatedData.status, is_active: validatedData.status === 'publish',
                description: validatedData.description, short_description: validatedData.short_description,
                sku: validatedData.sku, price: parseFloat(validatedData.price),
                regular_price: parseFloat(validatedData.regular_price),
                sale_price: parseFloat(validatedData.sale_price),
                on_sale: validatedData.on_sale, stock_quantity: validatedData.stock_quantity,
                stock_status: validatedData.stock_status, manage_stock: validatedData.manage_stock,
                wc_modified_at_gmt: new Date(validatedData.date_modified_gmt).toISOString(),
            });

            for (const image of validatedData.images) {
                imagesToUpsert.push({
                    wc_image_id: image.id, product_wc_id: validatedData.id,
                    src_url: image.src, alt_text: image.alt, position: image.position
                });
            }
            
            for (const category of validatedData.categories) {
                if (wcCategoryIdToUuidMap.has(category.id)) {
                    categoryMapsToUpsert.push({
                        product_wc_id: validatedData.id,
                        category_id: wcCategoryIdToUuidMap.get(category.id)
                    });
                }
            }
        }

        if (productsToUpsert.length > 0) {
            logger.info(`Enviando ${productsToUpsert.length} productos válidos a Supabase...`);
            const { data: insertedProducts, error: productError } = await supabase
                .from('products').upsert(productsToUpsert, { onConflict: 'wc_product_id' }).select('id, wc_product_id');

            if (productError) {
                logger.error({ error: productError }, 'Error al hacer upsert de productos.');
            } else {
                productsProcessed += productsToUpsert.length;
                logger.info(`Lote de productos guardado. Total procesado: ${productsProcessed} de ${totalProducts}`);
                const wcProductIdToUuidMap = new Map(insertedProducts.map(p => [p.wc_product_id, p.id]));
                
                const finalImages = imagesToUpsert.filter(img => wcProductIdToUuidMap.has(img.product_wc_id)).map(img => ({
                    wc_image_id: img.wc_image_id, product_id: wcProductIdToUuidMap.get(img.product_wc_id),
                    src_url: img.src_url, alt_text: img.alt_text, position: img.position
                }));
                if (finalImages.length > 0) {
                    const { error: imageError } = await supabase.from('product_images').upsert(finalImages, { onConflict: 'wc_image_id' });
                    if (imageError) logger.error({ error: imageError }, 'Error al hacer upsert de imágenes.');
                }

                const finalCategoryMaps = categoryMapsToUpsert.filter(map => wcProductIdToUuidMap.has(map.product_wc_id)).map(map => ({
                    product_id: wcProductIdToUuidMap.get(map.product_wc_id),
                    category_id: map.category_id
                }));
                if (finalCategoryMaps.length > 0) {
                    const { error: catMapError } = await supabase.from('product_categories_map').upsert(finalCategoryMaps);
                    if (catMapError) logger.error({ error: catMapError }, 'Error al hacer upsert del mapeo de categorías.');
                }
            }
        } else {
            logger.warn('Ningún producto en este lote era válido para ser enviado a Supabase.');
        }
        page++;
    }
}

async function main() {
    try {
        await syncCategories();
        await syncAllProducts();
        logger.info('✅ Sincronización masiva completada con éxito.');
    } catch (error) {
        logger.fatal({ error: util.inspect(error, {depth: 5}) }, 'La sincronización masiva ha fallado.');
        process.exit(1);
    }
}

main();