import React from 'react';
import { Box, Text, useStdout } from 'ink';

const ART_MIN_WIDTH = 56;

const ART = [
    '::  .. . * .  .-. .  =+++-..                   ',
    '+- :*.:=    *    =.*.-           =*               ',
    '            --   -=.:+++.:===.      .-:           ',
    '              ======:.=== -===:-====-:::-         ',
    '       :   =***--++.++++.:++-=+++:-*****+.        ',
    '      -  .****.-**** =*==*-*********# .+***.      ',
    '     .:   ==***+ **:****.*** +***- *********+     ',
    '       =++=-++*=-**+ =**+:*+.=+**++==+**-...      ',
    '      .+-==-+++.+++++:+++.-+---.++:               ',
    '       :- ========:==::=-.=====-=.-.              ',
    '      :===  .:-===.====. .====-: =====            ',
    '      -+:++++=.++++*+++          :+++++.          ',
    '    :  =+:=++-   .++++    .++++=    -++.          ',
    '        +.=- :++: :+++++++. -++++++          ..   ',
    '         .+++=..:+*:                              ',
    '      =   .+*:*+***+.*+=                          ',
    '       .      =++ :=+==- ======+ =++++-.....      ',
    '        ..      .: -==:.========-..               ',
    '          =.                                      ',
    '..     .    ::.   .                               ',
    '.*             .**               -*+          =*= ',
    '+                  ...*+++++*:..                  ',
];

const Logo: React.FC = () => {
    const { stdout } = useStdout();
    const cols = stdout?.columns ?? process.stdout.columns ?? 80;

    if (cols < ART_MIN_WIDTH) return null;

    return (
        <Box flexDirection="column" alignItems="flex-start" paddingY={1} paddingX={2}>
            {ART.map((line, i) => (
                <Text key={i} color="green">
                    {line}
                </Text>
            ))}
            <Box marginTop={1}>
                <Text color="green" dimColor>
                    [ Tyla — R-aware AI coding assistant ]
                </Text>
            </Box>
        </Box>
    );
};

export default Logo;
