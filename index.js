require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');
const crypto = require('crypto');
const pino = require('pino');

// --- 1. CONFIGURACIÓN Y CLIENTES ---
const app = express();
const PORT = process.env.PORT || 3001;

// Logger de producción
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Cliente de Supabase (usando la clave de servicio para bypass RLS)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- 2. MIDDLEWARE DE SEGURIDAD (VITAL) ---
// Middleware para verificar la firma del webhook de WooCommerce
// ¡IMPORTANTE! express.json() debe ser llamado DESPUÉS de esto para webhooks,
// porque necesitamos el body en formato raw (texto) para la verificación.
const verifyWooCommerceWebhook = (req, res, next) => {
    const wooSignature = req.headers['x-wc-webhook-signature'];
    if (!wooSignature) {
        logger.warn('Petición de webhook recibida sin firma.');
        return res.status(401).send('Firma del webhook no encontrada.');
    }

    // express.raw() lee el stream del body sin parsearlo a JSON
    express.raw({ type: 'application/json' })(req, res, (err) => {
        if (err) {
            return next(err);
        }

        const hmac = crypto.createHmac('sha256', process.env.WOOCOMMERCE_WEBHOOK_SECRET);
        const digest = Buffer.from(hmac.update(req.body).digest('base64'), 'utf8');
        const receivedSignature = Buffer.from(wooSignature, 'utf8');

        if (!crypto.timingSafeEqual(digest, receivedSignature)) {
            logger.error('Firma del webhook inválida.');
            return res.status(401).send('Firma del webhook inválida.');
        }

        // Si la firma es válida, parseamos el body a JSON para el siguiente middleware.
        req.body = JSON.parse(req.body.toString());
        next();
    });
};

// --- 3. VALIDACIÓN DE DATOS CON ZOD ---
// Define la estructura que esperas de un producto de WooCommerce
const ProductSchema = z.object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    type: z.enum(['simple', 'variable', 'bundle', 'variation']),
    status: z.string(),
    description: z.string().optional(),
    short_description: z.string().optional(),
    sku: z.string().optional().nullable(),
    price: z.string(), // El precio viene como string, lo convertiremos a número
    regular_price: z.string().optional().nullable(),
    sale_price: z.string().optional().nullable(),
    on_sale: z.boolean(),
    stock_quantity: z.number().int().nullable(),
    stock_status: z.enum(['instock', 'outofstock', 'onbackorder']),
    manage_stock: z.boolean(),
    date_modified_gmt: z.string().datetime(),
    // Añade aquí más campos que necesites validar
});

// Esquema para el evento de eliminación (es más simple)
const DeletedProductSchema = z.object({
    id: z.number().int(),
});

// --- 4. EL ENDPOINT PRINCIPAL ---
// Aplicamos primero el middleware de verificación
app.post('/api/sync/woocommerce', verifyWooCommerceWebhook, async (req, res) => {
    const eventTopic = req.headers['x-wc-webhook-topic'];
    logger.info({ topic: eventTopic, productId: req.body.id }, 'Webhook recibido y verificado.');

    try {
        if (eventTopic === 'product.deleted') {
            const { id } = DeletedProductSchema.parse(req.body);

            const { error } = await supabase
                .from('products')
                .update({ is_active: false, updated_at: new Date().toISOString() })
                .eq('wc_product_id', id);

            if (error) throw error;
            logger.info({ wc_product_id: id }, 'Producto marcado como inactivo.');

        } else if (eventTopic === 'product.created' || eventTopic === 'product.updated') {
            const productData = ProductSchema.parse(req.body);

            const transformedProduct = {
                wc_product_id: productData.id,
                name: productData.name,
                slug: productData.slug,
                type: productData.type,
                status: productData.status,
                is_active: productData.status === 'publish',
                description: productData.description || '',
                short_description: productData.short_description || '',
                sku: productData.sku || '',
                regular_price: parseFloat(productData.regular_price) || 0,
                sale_price: parseFloat(productData.sale_price) || 0,
                price: parseFloat(productData.price) || 0,
                on_sale: productData.on_sale,
                stock_quantity: productData.stock_quantity,
                stock_status: productData.stock_status,
                manage_stock: productData.manage_stock,
                wc_modified_at_gmt: productData.date_modified_gmt,
                // Completa con el resto de campos de tu tabla
            };

            const { error } = await supabase
                .from('products')
                .upsert(transformedProduct, { onConflict: 'wc_product_id' });

            if (error) throw error;
            logger.info({ wc_product_id: productData.id }, 'Producto sincronizado correctamente.');
        }

        res.status(200).send({ status: 'success', message: 'Webhook procesado.' });

    } catch (error) {
        if (error instanceof z.ZodError) {
            logger.warn({ error: error.errors }, 'Error de validación de datos del webhook.');
            return res.status(400).send({ status: 'error', message: 'Datos inválidos.', details: error.errors });
        }
        logger.error({ error: error.message, stack: error.stack }, 'Error procesando el webhook.');
        res.status(500).send({ status: 'error', message: 'Error interno del servidor.' });
    }
});

// --- 5. INICIAR EL SERVIDOR ---
app.listen(PORT, () => {
    logger.info(`Servidor de producción escuchando en el puerto ${PORT}`);
});