// index.js - API para la App Móvil y Webhooks
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const pino = require('pino');
const cors = require('cors');

// --- 1. CONFIGURACIÓN Y CLIENTES ---
const app = express();
const PORT = process.env.PORT || 3001;
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
// --- Configuración de CORS ---
const whitelist = [
    'https://preview--solara-proyecto-gestor.lovable.app', // Tu frontend de preview
    // 'https://tu-dominio-de-produccion.com', // DESCOMENTA Y AÑADE TU DOMINIO FINAL AQUÍ
    'http://localhost:3000', // Si desarrollas el frontend en local
    'http://localhost:5173'  // Otro puerto común para Vite/React en local
];

const corsOptions = {
    origin: function (origin, callback) {
        // Permitir peticiones si están en la whitelist O si son del entorno de desarrollo local
        if (whitelist.indexOf(origin) !== -1 || !origin || origin.startsWith('http://localhost:')) {
            callback(null, true);
        } else {
            // Logueamos el origen bloqueado para poder añadirlo si es necesario
            logger.warn({ origin: origin }, 'Origen bloqueado por CORS');
            callback(new Error('No permitido por la política de CORS'));
        }
    }
};


// Cliente de Supabase para el BACKEND (webhook) - USA LA SERVICE KEY
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Cliente de Supabase para el FRONTEND (endpoints públicos) - USA LA ANON KEY
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY // ¡OJO! Usamos la clave anónima aquí
);

// --- 2. MIDDLEWARE ---
// Middleware de seguridad para el webhook (ya lo tenías)
const verifyWooCommerceWebhook = (req, res, next) => {
    // ... (El código de verificación del webhook que ya tenías va aquí, sin cambios)
    const wooSignature = req.headers['x-wc-webhook-signature'];
    if (!wooSignature) {
        return res.status(401).send('Firma del webhook no encontrada.');
    }
    express.raw({ type: 'application/json' })(req, res, (err) => {
        if (err) return next(err);
        const hmac = crypto.createHmac('sha256', process.env.WOOCOMMERCE_WEBHOOK_SECRET);
        const digest = Buffer.from(hmac.update(req.body).digest('base64'), 'utf8');
        const receivedSignature = Buffer.from(wooSignature, 'utf8');
        if (!crypto.timingSafeEqual(digest, receivedSignature)) {
            return res.status(401).send('Firma del webhook inválida.');
        }
        req.body = JSON.parse(req.body.toString());
        next();
    });
};

// Middleware para parsear JSON en los endpoints públicos
app.use(cors(corsOptions));
app.use(express.json());


// --- 3. ENDPOINTS PARA LA APP MÓVIL (¡LO NUEVO!) ---

// GET /api/ecommerce/categories - Devuelve todas las categorías
app.get('/api/ecommerce/categories', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('categories')
            .select('*')
            .order('display_order', { ascending: true });

        if (error) throw error;

        res.status(200).json(data);
    } catch (error) {
        logger.error({ error }, 'Error al obtener categorías');
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});


// GET /api/ecommerce/products - Devuelve productos paginados y filtrados por categoría
app.get('/api/ecommerce/products', async (req, res) => {
    const { category_id, page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    try {
        let query = supabase
            .from('products')
            .select(`
                *,
                product_images ( id, src_url, is_main_image ),
                product_categories_map!inner ( category_id )
            `, { count: 'exact' })
            .order('name', { ascending: true })
            .range(offset, offset + limitNum - 1);

        // Si se proporciona un category_id, filtramos
        if (category_id) {
            query = query.eq('product_categories_map.category_id', category_id);
        }

        const { data, error, count } = await query;

        if (error) throw error;
        
        // Limpiamos los datos para que sean más fáciles de usar en el frontend
        const cleanedData = data.map(p => ({
            ...p,
            main_image: p.product_images.find(img => img.is_main_image) || p.product_images[0] || null
        }));

        res.status(200).json({
            data: cleanedData,
            totalPages: Math.ceil(count / limitNum),
            currentPage: pageNum,
            totalProducts: count,
        });

    } catch (error) {
        logger.error({ error }, 'Error al obtener productos');
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});


// GET /api/ecommerce/products/:id - Devuelve un solo producto por su ID (UUID)
app.get('/api/ecommerce/products/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const { data, error } = await supabase
            .from('products')
            .select(`
                *,
                product_images ( * ),
                categories ( id, name )
            `)
            .eq('id', id)
            .single(); // .single() devuelve un objeto en lugar de un array

        if (error) {
            if (error.code === 'PGRST116') { // Código de error de Supabase para "no rows found"
                return res.status(404).json({ message: 'Producto no encontrado' });
            }
            throw error;
        }
        
        res.status(200).json(data);

    } catch (error) {
        logger.error({ error }, `Error al obtener el producto ${id}`);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});


// --- 4. ENDPOINT PARA EL WEBHOOK DE WOOCOMMERCE ---
// ¡OJO! La verificación se aplica solo a esta ruta, no a las públicas
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