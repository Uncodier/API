import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { waitForSubmittedCommand } from '@/lib/agentbase/services/command/waitForSubmittedCommand';

export const maxDuration = 300;
export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
export function isValidDomain(domain: string): boolean {
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
    return domainRegex.test(domain);
}
export function extractDomainFromUrl(url: string | null | undefined): string | null {
    if (!url || typeof url !== 'string')
        return null;
    try {
        const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
        return parsed.hostname.replace(/^www\./, '');
    }
    catch {
        const cleaned = url
            .replace(/^https?:\/\//i, '')
            .replace(/^www\./i, '')
            .split('/')[0]
            .trim();
        return cleaned || null;
    }
}
export async function findDataAnalystAgent(siteId: string): Promise<{
    agentId: string;
    userId: string;
} | null> {
    try {
        if (!siteId || !isValidUUID(siteId)) {
            console.error(`❌ Invalid site_id for Data Analyst agent search: ${siteId}`);
            return null;
        }
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('id, user_id')
            .eq('site_id', siteId)
            .eq('role', 'Data Analyst')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error('Error al buscar agente con role "Data Analyst":', error);
            return null;
        }
        if (!data || data.length === 0) {
            console.log(`⚠️ No se encontró ningún agente con role "Data Analyst" activo para el sitio: ${siteId}`);
            return null;
        }
        return {
            agentId: data[0].id,
            userId: data[0].user_id
        };
    }
    catch (error) {
        console.error('Error al buscar agente Data Analyst:', error);
        return null;
    }
}
export function detectLanguageAndRegion(name: string, context: string): {
    language: string;
    region: string;
    cultural_patterns: string[];
} {
    const nameWords = name.toLowerCase().split(' ');
    const contextLower = context.toLowerCase();
    const spanishPatterns = ['maría', 'josé', 'juan', 'carlos', 'ana', 'luis', 'antonio', 'francisco', 'manuel', 'carmen', 'isabel', 'miguel', 'rafael', 'fernando', 'diego', 'alejandro', 'gonzález', 'rodríguez', 'martínez', 'lópez', 'garcía', 'pérez', 'sánchez', 'ramírez', 'torres', 'flores', 'rivera', 'gómez', 'díaz', 'hernández'];
    const frenchPatterns = ['jean', 'marie', 'pierre', 'michel', 'alain', 'philippe', 'bernard', 'christophe', 'nicolas', 'daniel', 'françois', 'laurent', 'david', 'julien', 'pascal', 'thierry', 'olivier', 'sébastien', 'fabrice', 'stéphane', 'dupont', 'martin', 'bernard', 'thomas', 'petit', 'robert', 'richard', 'durand', 'dubois', 'moreau'];
    const germanPatterns = ['hans', 'peter', 'wolfgang', 'klaus', 'jürgen', 'dieter', 'günter', 'frank', 'bernd', 'stefan', 'thomas', 'michael', 'andreas', 'christian', 'werner', 'helmut', 'uwe', 'rainer', 'müller', 'schmidt', 'schneider', 'fischer', 'weber', 'meyer', 'wagner', 'becker', 'schulz', 'hoffmann', 'schäfer'];
    const italianPatterns = ['mario', 'giovanni', 'antonio', 'francesco', 'luigi', 'vincenzo', 'giuseppe', 'salvatore', 'michele', 'angelo', 'carlo', 'roberto', 'stefano', 'andrea', 'marco', 'paolo', 'alessandro', 'massimo', 'rossi', 'russo', 'ferrari', 'esposito', 'bianchi', 'romano', 'colombo', 'ricci', 'marino', 'greco', 'bruno'];
    const dutchPatterns = ['jan', 'pieter', 'kees', 'henk', 'willem', 'geert', 'dirk', 'piet', 'johan', 'cornelis', 'anton', 'johannes', 'adrianus', 'jacobus', 'van', 'de', 'der', 'den', 'jansen', 'bakker', 'visser', 'smit', 'meijer', 'boer', 'mulder', 'berg', 'dijkstra'];
    let language = 'english';
    let region = 'international';
    let cultural_patterns: string[] = [];
    if (nameWords.some(word => spanishPatterns.includes(word))) {
        language = 'spanish';
        region = 'hispanic';
        cultural_patterns = ['compound_first_names', 'maternal_surnames', 'formal_titles'];
    }
    else if (nameWords.some(word => frenchPatterns.includes(word))) {
        language = 'french';
        region = 'france';
        cultural_patterns = ['hyphenated_names', 'formal_address'];
    }
    else if (nameWords.some(word => germanPatterns.includes(word))) {
        language = 'german';
        region = 'germany';
        cultural_patterns = ['compound_names', 'professional_titles'];
    }
    else if (nameWords.some(word => italianPatterns.includes(word))) {
        language = 'italian';
        region = 'italy';
        cultural_patterns = ['multiple_surnames', 'regional_variations'];
    }
    else if (nameWords.some(word => dutchPatterns.includes(word))) {
        language = 'dutch';
        region = 'netherlands';
        cultural_patterns = ['tussenvoegsel', 'compound_surnames'];
    }
    const regionKeywords = {
        'spain': 'spanish',
        'méxico': 'spanish',
        'argentina': 'spanish',
        'colombia': 'spanish',
        'chile': 'spanish',
        'france': 'french',
        'canada': 'bilingual',
        'germany': 'german',
        'italy': 'italian',
        'netherlands': 'dutch',
        'brazil': 'portuguese',
        'portugal': 'portuguese',
        'uk': 'british',
        'united kingdom': 'british',
        'australia': 'australian',
        'ireland': 'irish'
    };
    for (const [country, lang] of Object.entries(regionKeywords)) {
        if (contextLower.includes(country)) {
            if (lang === 'spanish') {
                language = 'spanish';
                region = 'hispanic';
                cultural_patterns = ['compound_first_names', 'maternal_surnames', 'formal_titles'];
            }
            else if (lang === 'french') {
                language = 'french';
                region = 'france';
                cultural_patterns = ['hyphenated_names', 'formal_address'];
            }
            break;
        }
    }
    return { language, region, cultural_patterns };
}
export function generateCulturalEmailPatterns(name: string, domain: string, language: string, region: string, cultural_patterns: string[]): string[] {
    const patterns: string[] = [];
    const nameParts = name.toLowerCase().split(' ').filter(part => part.length > 0);
    if (nameParts.length === 0)
        return patterns;
    const firstName = nameParts[0];
    const lastName = nameParts[nameParts.length - 1];
    if (language === 'spanish' || region === 'hispanic') {
        if (nameParts.length >= 3) {
            const paternalSurname = nameParts[nameParts.length - 2];
            const maternalSurname = nameParts[nameParts.length - 1];
            patterns.push(`${firstName}.${paternalSurname}@${domain}`);
            patterns.push(`${firstName}.${paternalSurname}.${maternalSurname}@${domain}`);
            patterns.push(`${firstName}${paternalSurname}@${domain}`);
        }
        if (nameParts.length >= 2 && nameParts[0].length <= 6 && nameParts[1].length <= 6) {
            const compoundFirst = `${nameParts[0]}${nameParts[1]}`;
            patterns.push(`${compoundFirst}@${domain}`);
            if (lastName) {
                patterns.push(`${compoundFirst}.${lastName}@${domain}`);
            }
        }
    }
    if (language === 'dutch' || region === 'netherlands') {
        const tussenvoegselWords = ['van', 'de', 'der', 'den', 'van der', 'van den'];
        let cleanedName = name.toLowerCase();
        for (const tussenvoegsel of tussenvoegselWords) {
            if (cleanedName.includes(` ${tussenvoegsel} `)) {
                const beforeTussen = cleanedName.split(` ${tussenvoegsel} `)[0].split(' ').pop() || '';
                const afterTussen = cleanedName.split(` ${tussenvoegsel} `)[1].split(' ')[0] || '';
                patterns.push(`${firstName}.${beforeTussen}@${domain}`);
                patterns.push(`${firstName}.${afterTussen}@${domain}`);
                patterns.push(`${firstName}.${tussenvoegsel.replace(/\s/g, '')}.${afterTussen}@${domain}`);
            }
        }
    }
    if (language === 'german' || region === 'germany') {
        if (firstName && lastName) {
            patterns.push(`${firstName}.${lastName}@${domain}`);
            patterns.push(`${lastName}.${firstName}@${domain}`);
        }
    }
    if (language === 'french' || region === 'france') {
        const hyphenatedParts = name.split('-');
        if (hyphenatedParts.length > 1) {
            const cleanParts = hyphenatedParts.map(part => part.toLowerCase().trim());
            patterns.push(`${cleanParts.join('')}@${domain}`);
            patterns.push(`${cleanParts.join('.')}@${domain}`);
        }
    }
    return patterns;
}
export function isExecutivePosition(context: string): boolean {
    const contextLower = context.toLowerCase();
    const executiveRoles = [
        'ceo', 'cto', 'cfo', 'cmo', 'coo', 'chief executive', 'chief technology', 'chief financial', 'chief marketing', 'chief operating',
        'director', 'directora', 'director general', 'directora general', 'director ejecutivo', 'directora ejecutiva',
        'director de', 'directora de', 'managing director', 'executive director',
        'gerente general', 'gerenta general', 'general manager', 'country manager',
        'regional manager', 'gerente regional', 'gerenta regional',
        'presidente', 'presidenta', 'president', 'vicepresidente', 'vicepresidenta', 'vice president', 'vp ',
        'fundador', 'fundadora', 'founder', 'co-founder', 'cofundador', 'cofundadora',
        'propietario', 'propietaria', 'owner', 'socio', 'socia', 'partner',
        'executive', 'ejecutivo', 'ejecutiva', 'senior manager', 'gerente senior', 'gerenta senior'
    ];
    return executiveRoles.some(role => contextLower.includes(role));
}
export function extractDepartmentFromContext(context: string): string[] {
    const departments = [];
    const contextLower = context.toLowerCase();
    const departmentMap: {
        [key: string]: string[];
    } = {
        'marketing director': ['marketing', 'mercadeo', 'mkt'],
        'sales director': ['sales', 'ventas', 'comercial'],
        'finance director': ['finance', 'finanzas', 'accounting'],
        'hr director': ['hr', 'rrhh', 'people'],
        'tech director': ['tech', 'it', 'sistemas'],
        'operations director': ['operations', 'ops', 'operaciones'],
        'director de marketing': ['marketing', 'mercadeo', 'mkt'],
        'director de ventas': ['sales', 'ventas', 'comercial'],
        'director de finanzas': ['finance', 'finanzas', 'accounting'],
        'director de rrhh': ['hr', 'rrhh', 'people'],
        'director de tecnología': ['tech', 'it', 'sistemas'],
        'director de operaciones': ['operations', 'ops', 'operaciones'],
        'ceo': ['ceo', 'gerencia', 'direccion'],
        'cto': ['cto', 'tech', 'technology'],
        'cfo': ['cfo', 'finance', 'finanzas'],
        'cmo': ['cmo', 'marketing', 'mercadeo'],
        'marketing': ['marketing', 'mercadeo', 'mkt'],
        'ventas': ['ventas', 'sales', 'comercial'],
        'sales': ['sales', 'ventas', 'comercial'],
        'recursos humanos': ['rrhh', 'hr', 'people'],
        'human resources': ['hr', 'rrhh', 'people'],
        'tecnología': ['tech', 'it', 'sistemas'],
        'technology': ['tech', 'it', 'sistemas'],
        'finanzas': ['finanzas', 'finance', 'contabilidad'],
        'finance': ['finance', 'finanzas', 'accounting'],
        'operaciones': ['ops', 'operaciones', 'operations'],
        'operations': ['operations', 'ops', 'operaciones'],
        'legal': ['legal', 'juridico', 'compliance'],
        'comunicaciones': ['comunicaciones', 'comm', 'prensa'],
        'communications': ['comm', 'comunicaciones', 'pr'],
        'diseño': ['design', 'diseno', 'creative'],
        'design': ['design', 'diseno', 'creative'],
        'producto': ['product', 'producto', 'pm'],
        'product': ['product', 'producto', 'pm'],
        'soporte': ['support', 'soporte', 'help'],
        'support': ['support', 'soporte', 'help'],
        'director': ['gerencia', 'direccion'],
        'gerente': ['gerencia', 'management', 'direccion']
    };
    for (const [role, prefixes] of Object.entries(departmentMap)) {
        if (contextLower.includes(role)) {
            departments.push(...prefixes);
            break;
        }
    }
    return Array.from(new Set(departments));
}
