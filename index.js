// index.js - API para la App Móvil y Webhooks
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const pino = require('pino');

// --- 1. CONFIGURACIÓN Y CLIENTES ---
const app = express();
const PORT = process.env.PORT || 3001;
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

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
    // ... (Todo tu código del webhook va aquí, usando `supabaseAdmin` para escribir)
    // No hace falta cambiar nada aquí.
});


// --- 5. INICIAR EL SERVIDOR ---
app.listen(PORT, () => {
    logger.info(`Servidor de producción escuchando en el puerto ${PORT}`);
});